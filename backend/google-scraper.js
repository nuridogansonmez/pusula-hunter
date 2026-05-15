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

      // Accept Google cookies on first visit
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(randomDelay(1500, 3000));

      try {
        const acceptBtn = page.locator('button:has-text("Tümünü kabul et"), button:has-text("Accept all"), button:has-text("Kabul")');
        if (await acceptBtn.first().isVisible({ timeout: 4000 })) {
          await acceptBtn.first().click();
          await page.waitForTimeout(randomDelay(1000, 2000));
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

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(name)}&hl=tr&gl=tr`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(randomDelay(2000, 3500));

    const result = await page.evaluate(() => {
      const data = {
        phone: '',
        website: '',
        address: '',
        instagram: ''
      };

      // --- Phone extraction ---
      // Try tel: links first (most reliable)
      const telLink = document.querySelector('a[href^="tel:"]');
      if (telLink) {
        data.phone = telLink.getAttribute('href').replace('tel:', '').trim();
      }

      if (!data.phone) {
        // Look for phone near "Telefon" text in knowledge panel
        const allText = document.querySelectorAll('span, div');
        for (const el of allText) {
          const text = el.textContent || '';
          const parentText = el.parentElement?.textContent || '';
          // Turkish phone pattern: starts with 0 or +90, 10-11 digits
          const phoneMatch = text.match(/^(\+90|0)\s?(\d{3})\s?(\d{3})\s?(\d{2})\s?(\d{2})$/);
          if (phoneMatch && text.length < 20) {
            data.phone = text.trim();
            break;
          }
          // Look for "Telefon" label with nearby phone
          if ((parentText.includes('Telefon') || parentText.includes('telefon')) && text.length < 20) {
            const phoneMatch2 = text.match(/[\d\s\+\-\(\)]{7,}/);
            if (phoneMatch2 && phoneMatch2[0].replace(/\D/g, '').length >= 7) {
              data.phone = phoneMatch2[0].trim();
              break;
            }
          }
        }
      }

      if (!data.phone) {
        // Broader phone pattern search in knowledge panel area
        const kpPanel = document.querySelector('[data-attrid*="phone"], [data-ved][class*="knowledge"]') ||
                        document.querySelector('.kp-header') ||
                        document.querySelector('[class*="kp-"]');
        if (kpPanel) {
          const kpText = kpPanel.textContent || '';
          const phoneMatch = kpText.match(/(\+?90\s?)?0?\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}/);
          if (phoneMatch) data.phone = phoneMatch[0].trim();
        }
      }

      // --- Website extraction ---
      // Knowledge panel website link
      const websiteSelectors = [
        'a[data-attrid*="website"]',
        'a[href*="//"][data-ved][jsname]',
        '.ab_button[href*="http"]',
      ];
      for (const sel of websiteSelectors) {
        const el = document.querySelector(sel);
        if (el && el.href && !el.href.includes('google.com') && !el.href.includes('facebook.com') && !el.href.includes('instagram.com')) {
          data.website = el.href;
          break;
        }
      }

      if (!data.website) {
        // Look for website in knowledge panel by text
        const allAnchors = document.querySelectorAll('a[href^="http"]');
        for (const a of allAnchors) {
          const href = a.href || '';
          if (href.includes('google.com') || href.includes('facebook.com') ||
              href.includes('instagram.com') || href.includes('twitter.com') ||
              href.includes('youtube.com') || href.includes('maps.google') ||
              href.includes('kolayrandevu.com') || href.includes('maps.app')) {
            continue;
          }
          // Only pick up links that look like business websites (not ads)
          const parentText = a.closest('[data-attrid]')?.getAttribute('data-attrid') || '';
          if (parentText.includes('website') || parentText.includes('url')) {
            data.website = href;
            break;
          }
        }
      }

      // --- Address extraction ---
      // Look for "Adres:" label
      const addrSelectors = [
        '[data-attrid*="address"]',
        '[data-attrid="kc:/location/location:address"]',
      ];
      for (const sel of addrSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          data.address = el.textContent?.replace(/^Adres[:：]?\s*/i, '').trim() || '';
          break;
        }
      }

      if (!data.address) {
        // Text-based: find element near "Adres" keyword
        const allSpans = document.querySelectorAll('span');
        for (let i = 0; i < allSpans.length; i++) {
          const span = allSpans[i];
          if (span.textContent?.trim() === 'Adres' || span.textContent?.trim() === 'Address') {
            // Next sibling or parent's next element likely has the address
            const next = span.nextElementSibling || span.parentElement?.nextElementSibling;
            if (next && next.textContent.length > 5) {
              data.address = next.textContent.trim();
              break;
            }
          }
        }
      }

      // --- Instagram extraction ---
      const igLinks = document.querySelectorAll('a[href*="instagram.com"]');
      for (const a of igLinks) {
        const href = a.href || '';
        // Skip generic instagram.com links, pick profile links
        if (href.match(/instagram\.com\/[a-zA-Z0-9_.]+\/?($|\?)/)) {
          data.instagram = href.split('?')[0];
          break;
        }
      }

      return data;
    });

    const business = {
      campaign_id: this.campaignId,
      name: name.trim(),
      phone: result.phone || '',
      mobile: '',
      website: result.website || '',
      email: '',
      address: result.address || '',
      city: '',
      district: '',
      rating: 0,
      review_count: 0,
      category: category || '',
      google_maps_url: '',
      latitude: 0,
      longitude: 0,
      social_media: result.instagram ? JSON.stringify({ instagram: result.instagram }) : '{}'
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
    if (business.address) this.log('address', `Adres bulundu`);
    if (result.instagram) this.log('info', `Instagram: ${result.instagram}`);

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
