import { chromium } from 'playwright';
import db from './database.js';

const SCROLL_PAUSE = 2000;
const MAX_SCROLLS = 15;
const NOW_SQL = `datetime('now')`;

function updateStatus(id, status) {
  db.prepare(`UPDATE campaigns SET status = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(status, id);
}

export class GoogleMapsScraper {
  constructor(campaignId, onLog, onData, onStatusChange) {
    this.campaignId = campaignId;
    this.onLog = onLog || (() => {});
    this.onData = onData || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.browser = null;
    this.cancelled = false;
    this.paused = false;
    this.startTime = null;
  }

  log(type, message) {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    this.onLog({ timestamp, type, message });
  }

  async start() {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(this.campaignId);
    if (!campaign) throw new Error('Kampanya bulunamadi');

    this.startTime = Date.now();
    updateStatus(this.campaignId, 'running');
    this.onStatusChange('running');

    try {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
      });

      const context = await this.browser.newContext({
        locale: 'tr-TR',
        geolocation: { latitude: 41.0082, longitude: 28.9784 },
        permissions: ['geolocation'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      });

      const page = await context.newPage();

      let searchQuery = campaign.keyword;
      if (campaign.city) searchQuery += ` ${campaign.city}`;
      if (campaign.districts) {
        const districts = JSON.parse(campaign.districts || '[]');
        if (districts.length > 0) {
          await this.scrapeMultipleDistricts(page, campaign, districts);
          return;
        }
      }

      await this.scrapeQuery(page, campaign, searchQuery);

    } catch (error) {
      if (!this.cancelled) {
        this.log('error', `Hata: ${error.message}`);
        updateStatus(this.campaignId, 'error');
        this.onStatusChange('error');
      }
    } finally {
      if (this.browser) await this.browser.close();
      this.updateDuration();
    }
  }

  async scrapeMultipleDistricts(page, campaign, districts) {
    for (const district of districts) {
      if (this.cancelled) break;
      while (this.paused) {
        await new Promise(r => setTimeout(r, 1000));
      }
      const query = `${campaign.keyword} ${district} ${campaign.city}`;
      this.log('info', `Ilce taraniyor: ${district}`);
      await this.scrapeQuery(page, campaign, query);
    }
    if (!this.cancelled) {
      updateStatus(this.campaignId, 'completed');
      this.onStatusChange('completed');
      this.log('success', 'Kampanya tamamlandi!');
    }
  }

  async scrapeQuery(page, campaign, searchQuery) {
    this.log('info', `Araniyor: ${searchQuery}`);

    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    await page.waitForTimeout(5000);

    try {
      const acceptBtn = page.locator('button:has-text("Kabul"), button:has-text("Accept"), form[action*="consent"] button');
      if (await acceptBtn.first().isVisible({ timeout: 3000 })) {
        await acceptBtn.first().click();
        await page.waitForTimeout(2000);
      }
    } catch {}

    const feedSelector = 'div[role="feed"]';
    try {
      await page.waitForSelector(feedSelector, { timeout: 10000 });
    } catch {
      this.log('warning', 'Sonuc listesi bulunamadi, sayfa yapisi farkli olabilir');
      if (!this.cancelled) {
        updateStatus(this.campaignId, 'completed');
        this.onStatusChange('completed');
      }
      return;
    }

    let previousCount = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      if (this.cancelled) return;
      while (this.paused) {
        await new Promise(r => setTimeout(r, 1000));
      }

      await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (feed) feed.scrollTop = feed.scrollHeight;
      }, feedSelector);

      await page.waitForTimeout(SCROLL_PAUSE);

      const currentCount = await page.locator(`${feedSelector} > div > div > a`).count();
      this.log('info', `Scroll ${i + 1}: ${currentCount} isletme bulundu`);

      if (currentCount === previousCount) {
        const endOfList = await page.locator('span.HlvSq, p.fontBodyMedium:has-text("sonuna ulastiniz")').count();
        if (endOfList > 0 || i > 3) break;
      }
      previousCount = currentCount;
    }

    const links = await page.locator(`${feedSelector} > div > div > a`).evaluateAll(els =>
      els.map(el => el.getAttribute('href')).filter(Boolean)
    );

    this.log('success', `Toplam ${links.length} isletme bulundu, detaylar cekiliyor...`);

    for (let i = 0; i < links.length; i++) {
      if (this.cancelled) return;
      while (this.paused) {
        await new Promise(r => setTimeout(r, 1000));
      }

      try {
        await this.scrapeBusinessDetail(page, links[i], campaign);
      } catch (err) {
        this.log('warning', `Isletme ${i + 1} atlandi: ${err.message}`);
      }

      if (i % 5 === 0) {
        this.updateDuration();
        const count = db.prepare('SELECT COUNT(*) as c FROM businesses WHERE campaign_id = ?').get(this.campaignId);
        db.prepare(`UPDATE campaigns SET total_found = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
          .run(count.c, this.campaignId);
      }
    }

    if (!this.cancelled) {
      const count = db.prepare('SELECT COUNT(*) as c FROM businesses WHERE campaign_id = ?').get(this.campaignId);
      db.prepare(`UPDATE campaigns SET total_found = ?, status = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
        .run(count.c, 'completed', this.campaignId);
      this.onStatusChange('completed');
      this.log('success', `Tamamlandi! ${count.c} veri toplandi.`);
    }
  }

  async scrapeBusinessDetail(page, url, campaign) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const name = await page.locator('h1').first().textContent().catch(() => '');
    if (!name) return;

    const existing = db.prepare('SELECT id FROM businesses WHERE campaign_id = ? AND name = ?')
      .get(this.campaignId, name.trim());
    if (existing) {
      this.log('duplicate', `Mukerrer atlandi: ${name.trim()}`);
      return;
    }

    this.log('inspect', `Inceleniyor: ${name.trim()}`);

    const details = await page.evaluate(() => {
      const result = { phone: '', website: '', address: '', category: '' };
      const buttons = document.querySelectorAll('button[data-item-id]');

      buttons.forEach(btn => {
        const itemId = btn.getAttribute('data-item-id');
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const text = btn.textContent || '';

        if (itemId?.startsWith('phone:') || ariaLabel.includes('telefon') || ariaLabel.includes('phone')) {
          const phoneMatch = text.match(/[\d\s\+\-\(\)]{7,}/);
          if (phoneMatch) result.phone = phoneMatch[0].trim();
        }
        if (itemId === 'authority' || ariaLabel.includes('web') || ariaLabel.includes('site')) {
          const link = btn.querySelector('a')?.href || ariaLabel.replace('Web sitesi: ', '');
          if (link && link.includes('.')) result.website = link;
        }
        if (itemId === 'address' || ariaLabel.includes('adres') || ariaLabel.includes('address')) {
          result.address = ariaLabel.replace('Adres: ', '') || text.trim();
        }
      });

      if (!result.address) {
        const addrBtn = document.querySelector('button[data-item-id="address"]');
        if (addrBtn) result.address = addrBtn.getAttribute('aria-label')?.replace('Adres: ', '') || '';
      }

      if (!result.website) {
        const webLink = document.querySelector('a[data-item-id="authority"]');
        if (webLink) result.website = webLink.href;
      }

      const catEl = document.querySelector('button[jsaction*="category"]');
      if (catEl) result.category = catEl.textContent?.trim() || '';

      return result;
    });

    const ratingText = await page.locator('div.F7nice span[aria-hidden="true"]').first().textContent().catch(() => '0');
    const reviewText = await page.locator('div.F7nice span[aria-label]').first().getAttribute('aria-label').catch(() => '');

    const rating = parseFloat(ratingText?.replace(',', '.') || '0') || 0;
    const reviewCount = parseInt(reviewText?.match(/\d+/)?.[0] || '0') || 0;

    const coords = page.url().match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);

    const business = {
      campaign_id: this.campaignId,
      name: name.trim(),
      phone: details.phone,
      mobile: '',
      website: details.website,
      email: '',
      address: details.address,
      city: campaign.city || '',
      district: '',
      rating,
      review_count: reviewCount,
      category: details.category,
      google_maps_url: url,
      latitude: coords ? parseFloat(coords[1]) : 0,
      longitude: coords ? parseFloat(coords[2]) : 0,
      social_media: '{}'
    };

    db.prepare(`
      INSERT INTO businesses (campaign_id, name, phone, mobile, website, email, address, city, district, rating, review_count, category, google_maps_url, latitude, longitude, social_media)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      business.campaign_id, business.name, business.phone, business.mobile,
      business.website, business.email, business.address, business.city,
      business.district, business.rating, business.review_count, business.category,
      business.google_maps_url, business.latitude, business.longitude, business.social_media
    );

    this.log('data', `Veriler cikariliyor: ${business.name}`);
    if (business.rating) this.log('rating', `Puan: ${business.rating} / ${business.review_count} yorum`);
    if (business.phone) this.log('phone', `Telefon bulundu: ${business.phone}`);
    if (business.website) this.log('website', `Web sitesi: ${business.website}`);
    if (business.address) this.log('address', `Adres bulundu`);

    this.onData(business);
  }

  updateDuration() {
    if (!this.startTime) return;
    const seconds = Math.floor((Date.now() - this.startTime) / 1000);
    db.prepare(`UPDATE campaigns SET duration_seconds = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
      .run(seconds, this.campaignId);
  }

  cancel() {
    this.cancelled = true;
    updateStatus(this.campaignId, 'cancelled');
    this.onStatusChange('cancelled');
    this.log('warning', 'Kampanya iptal edildi');
  }

  pause() {
    this.paused = true;
    updateStatus(this.campaignId, 'paused');
    this.onStatusChange('paused');
    this.log('info', 'Kampanya duraklatildi');
  }

  resume() {
    this.paused = false;
    updateStatus(this.campaignId, 'running');
    this.onStatusChange('running');
    this.log('info', 'Kampanya devam ediyor');
  }
}
