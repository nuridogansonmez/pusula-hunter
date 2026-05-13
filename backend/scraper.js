import { chromium } from 'playwright';
import db from './database.js';

const MAX_SCROLLS = 50;
const NOW_SQL = `datetime('now')`;

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 }
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
      await page.waitForTimeout(randomDelay(2000, 4000));
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

    await page.waitForTimeout(randomDelay(4000, 6000));

    // Cookie/consent dialog
    try {
      const acceptBtn = page.locator('button:has-text("Kabul"), button:has-text("Accept"), form[action*="consent"] button');
      if (await acceptBtn.first().isVisible({ timeout: 3000 })) {
        await acceptBtn.first().click();
        await page.waitForTimeout(randomDelay(1500, 3000));
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

    // --- PHASE 1: Scroll to collect all results ---
    this.log('info', 'Sonuclar yukleniyor, liste kaydiriliyor...');
    let previousCount = 0;
    let noChangeCount = 0;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      if (this.cancelled) return;
      while (this.paused) {
        await new Promise(r => setTimeout(r, 1000));
      }

      // Human-like scroll: small incremental steps
      await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (feed) {
          const step = 300 + Math.floor(Math.random() * 400);
          feed.scrollBy({ top: step, behavior: 'smooth' });
        }
      }, feedSelector);

      await page.waitForTimeout(randomDelay(1200, 2500));

      // Sometimes do a bigger scroll to trigger lazy loading
      if (i % 3 === 2) {
        await page.evaluate((sel) => {
          const feed = document.querySelector(sel);
          if (feed) feed.scrollBy({ top: 800 + Math.floor(Math.random() * 600), behavior: 'smooth' });
        }, feedSelector);
        await page.waitForTimeout(randomDelay(2000, 3500));
      }

      const currentCount = await page.locator(`${feedSelector} > div > div > a`).count();

      if (i % 4 === 0) {
        this.log('info', `Scroll ${i + 1}: ${currentCount} isletme bulundu`);
      }

      // Check if we've reached the end
      const endReached = await page.evaluate(() => {
        const texts = document.body.innerText;
        return texts.includes('sonuna ulaştınız') ||
               texts.includes("sonuna ulastiniz") ||
               texts.includes("You've reached the end") ||
               texts.includes('Daha fazla sonuç yok') ||
               document.querySelector('span.HlvSq') !== null;
      });

      if (endReached) {
        this.log('success', `Liste sonu tespit edildi. Toplam ${currentCount} isletme.`);
        break;
      }

      if (currentCount === previousCount) {
        noChangeCount++;
        if (noChangeCount >= 4) {
          // Try one last big scroll
          await page.evaluate((sel) => {
            const feed = document.querySelector(sel);
            if (feed) feed.scrollTop = feed.scrollHeight;
          }, feedSelector);
          await page.waitForTimeout(3000);
          const finalCount = await page.locator(`${feedSelector} > div > div > a`).count();
          if (finalCount === currentCount) {
            this.log('info', `Daha fazla sonuc yuklenmiyor. Toplam: ${finalCount}`);
            break;
          }
          noChangeCount = 0;
        }
      } else {
        noChangeCount = 0;
      }
      previousCount = currentCount;
    }

    // Collect all links
    const links = await page.locator(`${feedSelector} > div > div > a`).evaluateAll(els =>
      els.map(el => el.getAttribute('href')).filter(Boolean)
    );

    const uniqueLinks = [...new Set(links)];
    this.log('success', `Toplam ${uniqueLinks.length} benzersiz isletme bulundu, detaylar cekiliyor...`);

    // --- PHASE 2: Visit each business detail ---
    for (let i = 0; i < uniqueLinks.length; i++) {
      if (this.cancelled) return;
      while (this.paused) {
        await new Promise(r => setTimeout(r, 1000));
      }

      try {
        await this.scrapeBusinessDetail(page, uniqueLinks[i], campaign);
      } catch (err) {
        this.log('warning', `Isletme ${i + 1} atlandi: ${err.message}`);
      }

      // Human-like delay between detail pages
      await page.waitForTimeout(randomDelay(1500, 3500));

      if (i % 5 === 0) {
        this.updateDuration();
        const count = db.prepare('SELECT COUNT(*) as c FROM businesses WHERE campaign_id = ?').get(this.campaignId);
        db.prepare(`UPDATE campaigns SET total_found = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
          .run(count.c, this.campaignId);
      }

      // Occasional longer pause (like a human taking a break)
      if (i > 0 && i % 20 === 0) {
        this.log('info', `${i}/${uniqueLinks.length} tamamlandi, kisa mola...`);
        await page.waitForTimeout(randomDelay(4000, 7000));
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
    await page.waitForTimeout(randomDelay(2500, 4000));

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
