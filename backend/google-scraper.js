import { chromium } from 'playwright';
import db from './database.js';

const NOW_SQL = `datetime('now')`;

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function updateStatus(id, status) {
  db.prepare(`UPDATE campaigns SET status = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(status, id);
}

export class GoogleSearchScraper {
  constructor(campaignId, businessNames, onLog, onData, onStatusChange) {
    this.campaignId = campaignId;
    this.businessNames = businessNames; // array of { name, category }
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
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 }
      });

      const page = await context.newPage();

      // Accept Google cookies on first visit via Maps
      await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(randomDelay(3000, 5000));

      try {
        const acceptBtn = page.locator('button:has-text("Tümünü kabul et"), button:has-text("Accept all"), button:has-text("Kabul")');
        if (await acceptBtn.first().isVisible({ timeout: 4000 })) {
          await acceptBtn.first().click();
          await page.waitForTimeout(randomDelay(1500, 3000));
          this.log('info', 'Google cerezleri kabul edildi');
        }
      } catch {}

      const total = this.businessNames.length;
      this.log('info', `Toplam ${total} isletme Google'da aranacak`);

      for (let i = 0; i < this.businessNames.length; i++) {
        if (this.cancelled) break;
        while (this.paused) {
          await new Promise(r => setTimeout(r, 1000));
        }

        const item = this.businessNames[i];
        const name = typeof item === 'string' ? item : item.name;
        const category = typeof item === 'object' ? (item.category || '') : '';

        try {
          await this.searchBusiness(page, name, category);
        } catch (err) {
          this.log('warning', `Atlandi (${name}): ${err.message}`);
        }

        // Update progress
        if (i % 5 === 0) {
          this.updateDuration();
          const count = db.prepare('SELECT COUNT(*) as c FROM businesses WHERE campaign_id = ?').get(this.campaignId);
          db.prepare(`UPDATE campaigns SET total_found = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
            .run(count.c, this.campaignId);
          this.log('info', `Ilerleme: ${i + 1}/${total} tamamlandi`);
        }

        // Human-like delay between searches (3-7 seconds)
        if (i < this.businessNames.length - 1) {
          await page.waitForTimeout(randomDelay(3000, 7000));
        }

        // Longer pause every 30 searches
        if (i > 0 && i % 30 === 0) {
          this.log('info', `${i}/${total} tamamlandi, kisa mola...`);
          await page.waitForTimeout(randomDelay(8000, 15000));
        }
      }

      if (!this.cancelled) {
        const count = db.prepare('SELECT COUNT(*) as c FROM businesses WHERE campaign_id = ?').get(this.campaignId);
        db.prepare(`UPDATE campaigns SET total_found = ?, status = ?, updated_at = ${NOW_SQL} WHERE id = ?`)
          .run(count.c, 'completed', this.campaignId);
        this.onStatusChange('completed');
        this.log('success', `Tamamlandi! ${count.c} isletme islendi.`);
      }

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

  async searchBusiness(page, name, category) {
    // Check for duplicate before searching
    const existing = db.prepare('SELECT id FROM businesses WHERE campaign_id = ? AND name = ?')
      .get(this.campaignId, name.trim());
    if (existing) {
      this.log('duplicate', `Mukerrer atlandi: ${name.trim()}`);
      return;
    }

    this.log('inspect', `Araniyor: ${name}`);

    // Use Google Maps search instead of Google Search (avoids CAPTCHA)
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(name)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(randomDelay(4000, 6000));

    // Check if we landed on a direct business page (single result) or a list
    const hasDirectResult = await page.locator('h1').first().isVisible({ timeout: 3000 }).catch(() => false);

    if (!hasDirectResult) {
      // If it's a results list, try clicking the first result
      try {
        const firstResult = page.locator('div[role="feed"] > div > div > a').first();
        if (await firstResult.isVisible({ timeout: 5000 })) {
          await firstResult.click();
          await page.waitForTimeout(randomDelay(3000, 5000));
        }
      } catch {}
    }

    const result = await page.evaluate(() => {
      const data = { phone: '', website: '', address: '', instagram: '' };

      // === Google Maps detail page extraction ===
      const buttons = document.querySelectorAll('button[data-item-id]');
      buttons.forEach(btn => {
        const itemId = btn.getAttribute('data-item-id') || '';
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const text = btn.textContent || '';

        // Phone
        if (itemId.startsWith('phone:') || ariaLabel.includes('telefon') || ariaLabel.includes('phone')) {
          const phoneMatch = text.match(/[\d\s\+\-\(\)]{7,}/);
          if (phoneMatch) {
            const digits = phoneMatch[0].replace(/\D/g, '');
            if (digits.length >= 7 && !/^850|^900/.test(digits)) {
              data.phone = phoneMatch[0].trim();
            }
          }
        }

        // Address
        if (itemId === 'address' || ariaLabel.includes('adres') || ariaLabel.includes('address')) {
          data.address = ariaLabel.replace(/^Adres[:：]?\s*/i, '') || text.trim();
        }
      });

      // Website — only from Maps authority link (not organic results)
      if (!data.website) {
        const webLink = document.querySelector('a[data-item-id="authority"]');
        if (webLink) data.website = webLink.href;
      }

      // Fallback address
      if (!data.address) {
        const addrBtn = document.querySelector('button[data-item-id="address"]');
        if (addrBtn) data.address = addrBtn.getAttribute('aria-label')?.replace(/^Adres[:：]?\s*/i, '') || '';
      }

      // Also grab Maps URL and rating while we're here
      const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
      if (ratingEl) data.rating = ratingEl.textContent?.replace(',', '.') || '0';

      const reviewEl = document.querySelector('div.F7nice span[aria-label]');
      if (reviewEl) {
        const match = (reviewEl.getAttribute('aria-label') || '').match(/\d+/);
        if (match) data.reviewCount = match[0];
      }

      // Check if we actually found a Maps result
      const h1 = document.querySelector('h1');
      data.mapsFound = !!h1 && h1.textContent.trim().length > 0;

      return data;
    });

    // Get Maps URL if on a business page
    const mapsUrl = result.mapsFound ? page.url() : '';
    const coords = mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);

    // === GOOGLE SEARCH FALLBACK for Instagram + missing phone ===
    // Only if Maps didn't find phone OR we want Instagram data
    let googleResult = { instagram: '', phone: '' };

    if (!this.cancelled) {
      const needsGoogle = !result.phone || !result.mapsFound;
      // Always try Google for Instagram (Maps doesn't have it)
      this.log('info', `Google'da Instagram araniyor: ${name}`);
      await page.waitForTimeout(randomDelay(2000, 4000));

      try {
        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(name + ' instagram')}&hl=tr&gl=tr`;
        await page.goto(googleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(randomDelay(3000, 5000));

        googleResult = await page.evaluate(() => {
          const gData = { instagram: '', phone: '' };

          // Extract Instagram profile URL
          const igLinks = document.querySelectorAll('a[href*="instagram.com"]');
          for (const a of igLinks) {
            const href = a.href || '';
            if (href.match(/instagram\.com\/[a-zA-Z0-9_.]+\/?($|\?)/) && !href.includes('/p/') && !href.includes('/reel/')) {
              gData.instagram = href.split('?')[0];
              break;
            }
          }

          // Extract phone from Instagram snippet bio text
          if (gData.instagram) {
            const igLinks = document.querySelectorAll('a[href*="instagram.com"]');
            for (const a of igLinks) {
              // Walk up to find the result container
              let container = a.parentElement;
              for (let i = 0; i < 8 && container; i++) {
                container = container.parentElement;
              }
              if (container) {
                const text = container.textContent || '';
                // Turkish phone patterns
                const patterns = [
                  /(\+90|0)\s?\(?\d{3}\)?\s?\d{3}\s?\d{2}\s?\d{2}/,
                  /0\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}/,
                ];
                for (const p of patterns) {
                  const match = text.match(p);
                  if (match) {
                    const digits = match[0].replace(/\D/g, '');
                    if (digits.length >= 10 && !/^850|^900/.test(digits)) {
                      gData.phone = match[0].trim();
                      break;
                    }
                  }
                }
                if (gData.phone) break;
              }
            }
          }

          // Also try general page scan for phone if still empty
          if (!gData.phone) {
            const bodyText = document.body.innerText || '';
            const match = bodyText.match(/(\+90|0)\s?\(?\d{3}\)?\s?\d{3}\s?\d{2}\s?\d{2}/);
            if (match) {
              const digits = match[0].replace(/\D/g, '');
              if (digits.length >= 10 && !/^850|^900/.test(digits)) {
                gData.phone = match[0].trim();
              }
            }
          }

          return gData;
        });
      } catch (err) {
        this.log('warning', `Google arama atlandi: ${err.message}`);
      }
    }

    // Merge results: Maps data + Google fallback
    const finalPhone = result.phone || googleResult.phone || '';
    const finalInstagram = googleResult.instagram || '';

    const business = {
      campaign_id: this.campaignId,
      name: name.trim(),
      phone: finalPhone,
      mobile: '',
      website: result.website || '',
      email: '',
      address: result.address || '',
      city: '',
      district: '',
      rating: parseFloat(result.rating || '0') || 0,
      review_count: parseInt(result.reviewCount || '0') || 0,
      category: category || '',
      google_maps_url: mapsUrl,
      latitude: coords ? parseFloat(coords[1]) : 0,
      longitude: coords ? parseFloat(coords[2]) : 0,
      social_media: finalInstagram ? JSON.stringify({ instagram: finalInstagram }) : '{}'
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

    this.log('data', `Kaydedildi: ${business.name}`);
    if (business.phone) this.log('phone', `Telefon: ${business.phone}`);
    if (business.website) this.log('website', `Web: ${business.website}`);
    else this.log('info', `Sitesi yok — hedef musteri!`);
    if (business.address) this.log('address', `Adres bulundu`);
    if (finalInstagram) this.log('info', `Instagram: ${finalInstagram}`);

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
