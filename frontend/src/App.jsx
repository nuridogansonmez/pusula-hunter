import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const API = 'http://localhost:3001/api';
const WS_URL = 'ws://localhost:3001';

const statusLabels = {
  pending: 'Bekliyor',
  running: 'Çalışıyor',
  completed: 'Tamamlandı',
  cancelled: 'İptal Edildi',
  paused: 'Duraklatıldı',
  error: 'Hata'
};

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m} dk ${s} sn`;
}

function formatPhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('0')) cleaned = '90' + cleaned.slice(1);
  if (!cleaned.startsWith('+') && !cleaned.startsWith('90')) cleaned = '90' + cleaned;
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  return cleaned;
}

function openWhatsApp(phone, message) {
  const formatted = formatPhone(phone);
  if (!formatted) return;
  const encoded = encodeURIComponent(message || '');
  window.open(`https://wa.me/${formatted}?text=${encoded}`, '_blank');
}

function App() {
  const [page, setPage] = useState('data-hunt');
  const [campaigns, setCampaigns] = useState([]);
  const [updateStatus, setUpdateStatus] = useState(null); // null | 'checking' | 'available' | 'none' | 'updating' | 'done' | 'error'
  const [updateMessage, setUpdateMessage] = useState('');
  const [businesses, setBusinesses] = useState({});
  const [expandedCampaign, setExpandedCampaign] = useState(null);
  const [logs, setLogs] = useState({});
  const [stats, setStats] = useState({ totalCampaigns: 0, totalBusinesses: 0, activeCampaigns: 0 });
  const [searchQueue, setSearchQueue] = useState('');
  const [dataSearch, setDataSearch] = useState('');
  const [selectedCampaignData, setSelectedCampaignData] = useState(null);
  const [websiteFilter, setWebsiteFilter] = useState('all');
  const [campaignFilter, setCampaignFilter] = useState('all');

  // Notes state
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteText, setEditingNoteText] = useState('');

  // Partner data import state
  const [partnerImportName, setPartnerImportName] = useState('');
  const [partnerImportStatus, setPartnerImportStatus] = useState('');
  const [partnerImportUploading, setPartnerImportUploading] = useState(false);

  // WhatsApp state
  const [wpMessage, setWpMessage] = useState('');
  const [wpSentList, setWpSentList] = useState(new Set());
  const [showWpPanel, setShowWpPanel] = useState(false);

  // Import state
  const [importFiles, setImportFiles] = useState([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importSelected, setImportSelected] = useState(new Set());
  const [importCampaignName, setImportCampaignName] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [importUploading, setImportUploading] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formKeyword, setFormKeyword] = useState('');
  const [formCity, setFormCity] = useState('');
  const [formDistricts, setFormDistricts] = useState('');

  const wsRef = useRef(null);
  const logEndRef = useRef(null);

  const fetchCampaigns = useCallback(async () => {
    const res = await fetch(`${API}/campaigns`);
    const data = await res.json();
    setCampaigns(data);
  }, []);

  const fetchStats = useCallback(async () => {
    const res = await fetch(`${API}/stats`);
    const data = await res.json();
    setStats(data);
  }, []);

  const fetchImportFiles = useCallback(async () => {
    setImportLoading(true);
    try {
      const res = await fetch(`${API}/import/files`);
      const data = await res.json();
      setImportFiles(data.files || []);
    } catch {
      setImportFiles([]);
    } finally {
      setImportLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCampaigns();
    fetchStats();
    const saved = localStorage.getItem('pusula_wp_message');
    if (saved) setWpMessage(saved);
    const sentRaw = localStorage.getItem('pusula_wp_sent');
    if (sentRaw) setWpSentList(new Set(JSON.parse(sentRaw)));
  }, [fetchCampaigns, fetchStats]);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'log') {
        setLogs(prev => {
          const campaignLogs = prev[msg.data.campaignId] || [];
          return { ...prev, [msg.data.campaignId]: [...campaignLogs.slice(-200), msg.data] };
        });
      }

      if (msg.type === 'campaign_status' || msg.type === 'campaign_created' || msg.type === 'campaign_deleted') {
        fetchCampaigns();
        fetchStats();
      }

      if (msg.type === 'business_found') {
        setBusinesses(prev => {
          const list = prev[msg.data.campaignId] || [];
          return { ...prev, [msg.data.campaignId]: [...list, msg.data] };
        });
        fetchStats();
      }

      if (msg.type === 'update_status') {
        setUpdateMessage(msg.data.message);
        if (msg.data.step === 'done') {
          setUpdateStatus('done');
          setTimeout(() => window.location.reload(), 2000);
        } else if (msg.data.step === 'error') {
          setUpdateStatus('error');
        } else {
          setUpdateStatus('updating');
        }
      }
    };

    ws.onclose = () => {
      setUpdateStatus(prev => {
        if (prev === 'updating') {
          // Server restarting after update — poll until it's back then reload
          const poll = () => {
            fetch(`${API}/stats`).then(() => window.location.reload()).catch(() => setTimeout(poll, 2000));
          };
          setTimeout(poll, 3000);
          return 'done';
        }
        return prev;
      });
      setTimeout(() => { wsRef.current = new WebSocket(WS_URL); }, 3000);
    };

    return () => ws.close();
  }, [fetchCampaigns, fetchStats]);

  // Load all businesses when navigating to raw-data without a selected campaign
  useEffect(() => {
    if (page === 'raw-data' && !selectedCampaignData) {
      campaigns.forEach(c => {
        if (!businesses[c.id]) {
          loadBusinesses(c.id);
        }
      });
    }
  }, [page, selectedCampaignData, campaigns]);

  const saveWpMessage = (msg) => {
    setWpMessage(msg);
    localStorage.setItem('pusula_wp_message', msg);
  };

  const markAsSent = (phone) => {
    const newSet = new Set(wpSentList);
    newSet.add(formatPhone(phone));
    setWpSentList(newSet);
    localStorage.setItem('pusula_wp_sent', JSON.stringify([...newSet]));
  };

  const sendWhatsApp = (business) => {
    const phone = business.phone || business.mobile;
    if (!phone) return;
    let msg = wpMessage;
    msg = msg.replace(/\{isletme\}/gi, business.name || '');
    msg = msg.replace(/\{telefon\}/gi, phone || '');
    msg = msg.replace(/\{adres\}/gi, business.address || '');
    msg = msg.replace(/\{kategori\}/gi, business.category || '');
    openWhatsApp(phone, msg);
    markAsSent(phone);
  };

  const toggleImportFile = (filename) => {
    setImportSelected(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const selectAllImportFiles = () => {
    if (importSelected.size === importFiles.length) {
      setImportSelected(new Set());
    } else {
      setImportSelected(new Set(importFiles.map(f => f.filename)));
    }
  };

  const startImport = async () => {
    if (importSelected.size === 0) {
      setImportStatus('error:Lutfen en az 1 dosya secin');
      return;
    }
    setImportUploading(true);
    setImportStatus('loading');
    try {
      if (importSelected.size === 1) {
        const filename = [...importSelected][0];
        const name = importCampaignName.trim() || filename.replace('.json', '') + ' - Google Tarama';
        const res = await fetch(`${API}/import/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, campaignName: name })
        });
        const data = await res.json();
        if (!res.ok) { setImportStatus('error:' + (data.error || 'Hata olustu')); }
        else { setImportStatus('success:Kuyruga eklendi! ' + data.totalBusinesses + ' isletme'); }
      } else {
        const res = await fetch(`${API}/import/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: [...importSelected] })
        });
        const data = await res.json();
        if (!res.ok) { setImportStatus('error:' + (data.error || 'Hata olustu')); }
        else { setImportStatus('success:' + data.added.length + ' dosya kuyruga eklendi! Sirayla taranacak.'); }
      }
      setImportCampaignName('');
      setImportSelected(new Set());
      fetchCampaigns();
      fetchStats();
    } catch (err) {
      setImportStatus('error:' + err.message);
    } finally {
      setImportUploading(false);
    }
  };

  const handleJsonFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        alert('Gecersiz JSON: Bir dizi bekleniyor');
        return;
      }
      const campName = importCampaignName.trim() || file.name.replace('.json', '');
      setImportUploading(true);
      setImportStatus('loading');
      const res = await fetch(`${API}/import/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignName: campName, businesses: parsed })
      });
      const data = await res.json();
      if (!res.ok) {
        setImportStatus('error:' + (data.error || 'Hata olustu'));
      } else {
        setImportStatus('success:' + data.totalBusinesses);
        setImportCampaignName('');
        fetchCampaigns();
        fetchStats();
      }
    } catch (err) {
      setImportStatus('error:' + err.message);
    } finally {
      setImportUploading(false);
      e.target.value = '';
    }
  };

  const addCampaign = async (e) => {
    e.preventDefault();
    if (!formName || !formKeyword) return;

    const districts = formDistricts ? formDistricts.split(',').map(d => d.trim()).filter(Boolean) : [];
    await fetch(`${API}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formName,
        keyword: formKeyword,
        city: formCity,
        districts
      })
    });
    setFormName('');
    setFormKeyword('');
    setFormCity('');
    setFormDistricts('');
    fetchCampaigns();
  };

  const startCampaign = async (id) => {
    await fetch(`${API}/campaigns/${id}/start`, { method: 'POST' });
    fetchCampaigns();
  };

  const pauseCampaign = async (id) => {
    await fetch(`${API}/campaigns/${id}/pause`, { method: 'POST' });
    fetchCampaigns();
  };

  const resumeCampaign = async (id) => {
    await fetch(`${API}/campaigns/${id}/resume`, { method: 'POST' });
    fetchCampaigns();
  };

  const cancelCampaign = async (id) => {
    await fetch(`${API}/campaigns/${id}/cancel`, { method: 'POST' });
    fetchCampaigns();
  };

  const deleteCampaign = async (id) => {
    if (!confirm('Bu kampanyayı silmek istediğinize emin misiniz?')) return;
    await fetch(`${API}/campaigns/${id}`, { method: 'DELETE' });
    fetchCampaigns();
  };

  const startAll = async () => {
    await fetch(`${API}/campaigns/start-all`, { method: 'POST' });
    fetchCampaigns();
  };

  const checkUpdate = async () => {
    setUpdateStatus('checking');
    setUpdateMessage('GitHub kontrol ediliyor...');
    try {
      const res = await fetch(`${API}/update/check`);
      const data = await res.json();
      if (data.hasUpdate) {
        setUpdateStatus('available');
        setUpdateMessage(`${data.commits.length} yeni güncelleme mevcut`);
      } else {
        setUpdateStatus('none');
        setUpdateMessage('Uygulama güncel');
        setTimeout(() => setUpdateStatus(null), 3000);
      }
    } catch {
      setUpdateStatus('error');
      setUpdateMessage('Bağlantı hatası');
    }
  };

  const applyUpdate = async () => {
    setUpdateStatus('updating');
    setUpdateMessage('Güncelleme başlatılıyor...');
    await fetch(`${API}/update/apply`, { method: 'POST' });
  };

  const exportCampaign = (id, filter) => {
    const filterParam = filter ? `?filter=${filter}` : '';
    window.open(`${API}/campaigns/${id}/export${filterParam}`, '_blank');
  };

  const exportCampaignJson = (id) => {
    window.open(`${API}/campaigns/${id}/export-json`, '_blank');
  };

  const saveNote = async (businessId, notes) => {
    await fetch(`${API}/businesses/${businessId}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    // Update locally
    setBusinesses(prev => {
      const updated = {};
      for (const [cid, list] of Object.entries(prev)) {
        updated[cid] = list.map(b => b.id === businessId ? { ...b, notes } : b);
      }
      return updated;
    });
    setEditingNoteId(null);
  };

  const handlePartnerJsonUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        alert('Geçersiz JSON: Bir dizi bekleniyor');
        return;
      }
      const campName = partnerImportName.trim() || file.name.replace('.json', '');
      setPartnerImportUploading(true);
      setPartnerImportStatus('loading');
      const res = await fetch(`${API}/campaigns/import-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignName: campName, businesses: parsed })
      });
      const data = await res.json();
      if (!res.ok) {
        setPartnerImportStatus('error:' + (data.error || 'Hata oluştu'));
      } else {
        setPartnerImportStatus('success:' + data.totalBusinesses);
        setPartnerImportName('');
        fetchCampaigns();
        fetchStats();
      }
    } catch (err) {
      setPartnerImportStatus('error:' + err.message);
    } finally {
      setPartnerImportUploading(false);
      e.target.value = '';
    }
  };

  const loadBusinesses = async (campaignId) => {
    const res = await fetch(`${API}/campaigns/${campaignId}/businesses`);
    const data = await res.json();
    setBusinesses(prev => ({ ...prev, [campaignId]: data }));
  };

  const viewCampaignData = async (campaign) => {
    setSelectedCampaignData(campaign);
    setCampaignFilter('all');
    setPage('raw-data');
    await loadBusinesses(campaign.id);
  };

  // Load businesses when campaign filter changes
  const handleCampaignFilterChange = async (cid) => {
    setCampaignFilter(cid);
    if (cid !== 'all' && !businesses[cid]) {
      await loadBusinesses(cid);
    }
  };

  const toggleCampaign = (id) => {
    if (expandedCampaign === id) {
      setExpandedCampaign(null);
    } else {
      setExpandedCampaign(id);
      loadBusinesses(id);
    }
  };

  const filteredCampaigns = campaigns.filter(c =>
    c.name.toLowerCase().includes(searchQueue.toLowerCase()) ||
    c.keyword.toLowerCase().includes(searchQueue.toLowerCase())
  );

  const currentBusinesses = selectedCampaignData
    ? (businesses[selectedCampaignData.id] || [])
    : campaignFilter !== 'all'
      ? (businesses[campaignFilter] || [])
      : Object.values(businesses).flat();

  const filteredBusinesses = currentBusinesses.filter(b => {
    if (dataSearch && !(
      b.name?.toLowerCase().includes(dataSearch.toLowerCase()) ||
      b.phone?.includes(dataSearch) ||
      b.email?.toLowerCase().includes(dataSearch.toLowerCase())
    )) return false;

    if (websiteFilter === 'no-website' && b.website) return false;
    if (websiteFilter === 'has-website' && !b.website) return false;

    return true;
  });

  const noWebsiteCount = currentBusinesses.filter(b => !b.website).length;
  const hasWebsiteCount = currentBusinesses.filter(b => b.website).length;
  const businessesWithPhone = filteredBusinesses.filter(b => b.phone || b.mobile);

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon">P</div>
          <h1>Pusula Hunter</h1>
        </div>

        <div className="sidebar-section">Veri Toplama</div>
        <div className={`sidebar-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          Dashboard
        </div>
        <div className={`sidebar-item ${page === 'data-hunt' ? 'active' : ''}`} onClick={() => setPage('data-hunt')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          Data Avı
        </div>
        <div className={`sidebar-item ${page === 'json-import' ? 'active' : ''}`} onClick={() => { setPage('json-import'); fetchImportFiles(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          JSON Ice Aktar
        </div>
        <div className={`sidebar-item ${page === 'raw-data' && websiteFilter === 'all' ? 'active' : ''}`} onClick={() => { setPage('raw-data'); setSelectedCampaignData(null); setWebsiteFilter('all'); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
          Ham Datalar
        </div>

        <div className="sidebar-section">Pazarlama</div>
        <div className={`sidebar-item ${page === 'raw-data' && websiteFilter === 'no-website' ? 'active' : ''}`} onClick={() => { setPage('raw-data'); setSelectedCampaignData(null); setWebsiteFilter('no-website'); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
          Web Sitesi Olmayanlar
        </div>
        <div className={`sidebar-item ${page === 'whatsapp' ? 'active' : ''}`} onClick={() => setPage('whatsapp')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          WhatsApp Mesaj
        </div>

        <div className="sidebar-version">v1.1 — Pusula Hunter</div>

        <div className="sidebar-update">
          {updateStatus === null && (
            <button className="update-check-btn" onClick={checkUpdate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Güncelleme Kontrol Et
            </button>
          )}
          {updateStatus === 'checking' && (
            <div className="update-status checking">
              <span className="update-spinner"></span> {updateMessage}
            </div>
          )}
          {updateStatus === 'none' && (
            <div className="update-status ok">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>
              {updateMessage}
            </div>
          )}
          {updateStatus === 'available' && (
            <div className="update-available">
              <div className="update-badge">Yeni güncelleme!</div>
              <button className="update-apply-btn" onClick={applyUpdate}>
                Şimdi Güncelle
              </button>
              <button className="update-skip-btn" onClick={() => setUpdateStatus(null)}>Sonra</button>
            </div>
          )}
          {updateStatus === 'updating' && (
            <div className="update-status updating">
              <span className="update-spinner"></span>
              <span>{updateMessage}</span>
            </div>
          )}
          {updateStatus === 'done' && (
            <div className="update-status ok">
              Tamamlandı, yenileniyor...
            </div>
          )}
          {updateStatus === 'error' && (
            <div className="update-status error">
              {updateMessage}
              <button onClick={() => setUpdateStatus(null)} style={{marginLeft:6,fontSize:11}}>Kapat</button>
            </div>
          )}
        </div>
      </div>

      {/* Main */}
      <div className="main-content">
        {page === 'dashboard' && (
          <>
            <h2 style={{ marginBottom: 20 }}>Dashboard</h2>
            <div className="dashboard-stats">
              <div className="stat-card">
                <h3>Toplam Kampanya</h3>
                <div className="value">{stats.totalCampaigns}</div>
              </div>
              <div className="stat-card">
                <h3>Toplam Veri</h3>
                <div className="value">{stats.totalBusinesses}</div>
              </div>
              <div className="stat-card">
                <h3>Aktif Kampanya</h3>
                <div className="value">{stats.activeCampaigns}</div>
              </div>
            </div>
          </>
        )}

        {page === 'data-hunt' && (
          <>
            {/* New Campaign Form */}
            <form className="campaign-form" onSubmit={addCampaign}>
              <h2>Yeni Kampanya</h2>
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Kampanya Adi</label>
                  <input placeholder="Kampanya Adi" value={formName} onChange={e => setFormName(e.target.value)} required />
                </div>
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Arama Terimi</label>
                  <input placeholder="Arama Terimi (or: dis klinigi)" value={formKeyword} onChange={e => setFormKeyword(e.target.value)} required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Il</label>
                  <input placeholder="Il (or: Istanbul)" value={formCity} onChange={e => setFormCity(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Ilceler (virgulle ayirin)</label>
                  <input placeholder="Ilceler (or: Kadikoy, Besiktas, Atasehir)" value={formDistricts} onChange={e => setFormDistricts(e.target.value)} />
                </div>
                <div className="form-group" style={{ flex: 'none' }}>
                  <label>&nbsp;</label>
                  <button type="submit" className="btn btn-primary">+ Kuyruga Ekle</button>
                </div>
              </div>
            </form>

            {/* Campaign Queue */}
            <div className="queue-header">
              <h2>
                Kampanya Kuyrugu <span className="count">{campaigns.length} kampanya</span>
              </h2>
              <div className="queue-actions">
                <input
                  className="search-input"
                  placeholder="Kuyrukta ara..."
                  value={searchQueue}
                  onChange={e => setSearchQueue(e.target.value)}
                />
                <button className="btn btn-primary" onClick={startAll}>
                  Tumunu Baslat
                </button>
              </div>
            </div>

            {filteredCampaigns.map((campaign, idx) => (
              <div key={campaign.id} className="campaign-card">
                <div className="campaign-header" onClick={() => toggleCampaign(campaign.id)}>
                  <span className="campaign-number">#{idx + 1}</span>
                  <span className={`campaign-toggle ${expandedCampaign === campaign.id ? 'open' : ''}`}>
                    &#9660;
                  </span>
                  <span className="campaign-name">{campaign.name}</span>
                  <span className="campaign-tag tag-keyword">{campaign.keyword}</span>
                  {campaign.city && <span className="campaign-tag tag-city">{campaign.city}</span>}
                  {campaign.districts && JSON.parse(campaign.districts || '[]').length > 0 && (
                    <span className="campaign-tag tag-district">
                      {JSON.parse(campaign.districts).length} ilce
                    </span>
                  )}

                  <div className={`campaign-status status-${campaign.status}`}>
                    <span className="status-dot"></span>
                    {statusLabels[campaign.status] || campaign.status}
                  </div>

                  <div className="campaign-controls" onClick={e => e.stopPropagation()}>
                    {(campaign.status === 'pending' || campaign.status === 'cancelled' || campaign.status === 'error') && (
                      <button className="btn-icon" onClick={() => startCampaign(campaign.id)} title="Baslat">&#9654;</button>
                    )}
                    {campaign.status === 'running' && (
                      <button className="btn-icon" onClick={() => pauseCampaign(campaign.id)} title="Duraklat">&#9208;</button>
                    )}
                    {campaign.status === 'paused' && (
                      <button className="btn-icon" onClick={() => resumeCampaign(campaign.id)} title="Devam Et">&#9654;</button>
                    )}
                    {(campaign.status === 'running' || campaign.status === 'paused') && (
                      <button className="btn-icon" onClick={() => cancelCampaign(campaign.id)} title="Iptal">&#9209;</button>
                    )}
                    {campaign.status === 'completed' && campaign.total_found > 0 && (
                      <>
                        <button className="btn-icon" onClick={() => viewCampaignData(campaign)} title="Verileri Gor">&#128202;</button>
                        <button className="btn-icon" onClick={() => exportCampaign(campaign.id)} title="Excel Indir">&#128229;</button>
                        <button className="btn-icon btn-icon-json" onClick={() => exportCampaignJson(campaign.id)} title="JSON Indir">JSON</button>
                      </>
                    )}
                    <button className="btn-icon" onClick={() => deleteCampaign(campaign.id)} title="Sil">&#128465;</button>
                  </div>
                </div>

                {expandedCampaign === campaign.id && (
                  <div className="campaign-body">
                    <div className="campaign-stats">
                      <div className="stat">
                        <span className="stat-value">{campaign.total_found}</span> veri bulundu
                      </div>
                      <div className="stat">
                        Toplam sure: {formatDuration(campaign.duration_seconds || 0)}
                      </div>
                    </div>

                    {logs[campaign.id] && logs[campaign.id].length > 0 && (
                      <div className="live-log">
                        <h4>Canli Log</h4>
                        {logs[campaign.id].map((log, i) => (
                          <div key={i} className="log-entry">
                            <span className="log-time">{log.timestamp}</span>
                            <span className={`log-message log-${log.type}`}>{log.message}</span>
                          </div>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}

                    {businesses[campaign.id] && businesses[campaign.id].length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>
                            Bulunan Isletmeler ({businesses[campaign.id].length})
                          </span>
                          <button className="btn btn-sm btn-secondary" onClick={() => viewCampaignData(campaign)}>
                            Tumunu Gor
                          </button>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Isletme Adi</th>
                                <th>Telefon</th>
                                <th>Web Sitesi</th>
                                <th>Puan</th>
                              </tr>
                            </thead>
                            <tbody>
                              {businesses[campaign.id].slice(0, 5).map((b, i) => (
                                <tr key={i}>
                                  <td>{i + 1}</td>
                                  <td>{b.name}</td>
                                  <td className="phone-cell">{b.phone}</td>
                                  <td className="website-cell">
                                    {b.website && <a href={b.website} target="_blank" rel="noreferrer">{b.website.substring(0, 30)}...</a>}
                                  </td>
                                  <td>{b.rating > 0 ? `${b.rating}` : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {filteredCampaigns.length === 0 && (
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <p>Henuz kampanya eklenmemis. Yukaridan yeni kampanya ekleyin.</p>
              </div>
            )}
          </>
        )}

        {page === 'json-import' && (
          <div className="import-page">
            <h2 style={{ marginBottom: 4 }}>JSON Ice Aktar</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 24 }}>
              kolay-randevu-scrapper'dan alinan isletme listelerini Google'da arayip kaydedin.
            </p>

            <div className="import-section">
              <h3>Hazir Dosyalardan Ice Aktar</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 16 }}>
                /kolay-randevu-scrapper/results/ klasorunundeki JSON dosyalari:
              </p>

              {importLoading ? (
                <div className="import-loading">Dosyalar yukleniyor...</div>
              ) : importFiles.length === 0 ? (
                <div className="import-empty">Dosya bulunamadi. Dizin kontrol edin.</div>
              ) : (<>
                <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn btn-sm btn-secondary" onClick={selectAllImportFiles}>
                    {importSelected.size === importFiles.length ? 'Secimi Kaldir' : 'Tumunu Sec'}
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {importSelected.size > 0 ? `${importSelected.size} dosya secili` : 'Dosya secin (birden fazla secilebilir)'}
                  </span>
                </div>
                <div className="import-file-grid">
                  {importFiles.map(f => (
                    <div
                      key={f.filename}
                      className={`import-file-card ${importSelected.has(f.filename) ? 'selected' : ''}`}
                      onClick={() => toggleImportFile(f.filename)}
                    >
                      <div className="import-file-name">{f.filename.replace('.json', '')}</div>
                      <div className="import-file-count">{f.count} isletme</div>
                    </div>
                  ))}
                </div>
              </>)}

              <div className="import-form-row">
                {importSelected.size <= 1 && (
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Kampanya Adi {importSelected.size > 1 && '(otomatik)'}</label>
                  <input
                    placeholder="Bos birakilirsa dosya adindan olusturulur"
                    value={importCampaignName}
                    onChange={e => setImportCampaignName(e.target.value)}
                  />
                </div>
                )}
                <div className="form-group" style={{ flex: 'none' }}>
                  <label>&nbsp;</label>
                  <button
                    className="btn btn-primary"
                    onClick={startImport}
                    disabled={importUploading || importSelected.size === 0}
                  >
                    {importUploading ? 'Baslatiliyor...' : importSelected.size > 1 ? `${importSelected.size} Dosyayi Kuyruga Ekle` : 'Ice Aktar ve Tara'}
                  </button>
                </div>
              </div>
            </div>

            <div className="import-section" style={{ marginTop: 24 }}>
              <h3>Ozel JSON Dosyasi Yukle</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 12 }}>
                {"[{\"name\":\"...\",\"category\":\"...\"}] formatında JSON yukleyin"}
              </p>
              <div className="import-form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Kampanya Adi (opsiyonel)</label>
                  <input
                    placeholder="Bos birakilirsa dosya adi kullanilir"
                    value={importCampaignName}
                    onChange={e => setImportCampaignName(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ flex: 'none' }}>
                  <label>&nbsp;</label>
                  <label className="btn btn-secondary" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    JSON Dosyasi Sec
                    <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleJsonFileUpload} />
                  </label>
                </div>
              </div>
            </div>

            {importStatus && (
              <div className={`import-status-msg ${importStatus.startsWith('error') ? 'import-status-error' : importStatus === 'loading' ? 'import-status-loading' : 'import-status-success'}`}>
                {importStatus === 'loading' && (
                  <><span className="update-spinner"></span> Kampanya olusturuluyor ve tarama baslatiliyor...</>
                )}
                {importStatus.startsWith('success:') && (
                  <>Basarili! {importStatus.split(':')[1]} isletme icin Google taramasi basladi. Kampanya listesinden takip edebilirsiniz.</>
                )}
                {importStatus.startsWith('error:') && (
                  <>Hata: {importStatus.replace('error:', '')}</>
                )}
              </div>
            )}

            {/* Partner data direct import */}
            <div className="import-section" style={{ marginTop: 24 }}>
              <h3>Hazir Veri Yukle</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 12 }}>
                Ortaginizin disa aktardigi JSON dosyasini buraya yukleyin. Tarama yapilmaz, veriler dogrudan veritabanina kaydedilir.
              </p>
              <div className="import-form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Kampanya Adi (opsiyonel)</label>
                  <input
                    placeholder="Bos birakilirsa dosya adi kullanilir"
                    value={partnerImportName}
                    onChange={e => setPartnerImportName(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ flex: 'none' }}>
                  <label>&nbsp;</label>
                  <label className="btn btn-primary" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    {partnerImportUploading ? 'Yukleniyor...' : 'Yukle'}
                    <input type="file" accept=".json" style={{ display: 'none' }} onChange={handlePartnerJsonUpload} disabled={partnerImportUploading} />
                  </label>
                </div>
              </div>
              {partnerImportStatus && (
                <div className={`import-status-msg ${partnerImportStatus.startsWith('error') ? 'import-status-error' : partnerImportStatus === 'loading' ? 'import-status-loading' : 'import-status-success'}`} style={{ marginTop: 12 }}>
                  {partnerImportStatus === 'loading' && (
                    <><span className="update-spinner"></span> Veriler kaydediliyor...</>
                  )}
                  {partnerImportStatus.startsWith('success:') && (
                    <>Basarili! {partnerImportStatus.split(':')[1]} isletme veritabanina eklendi.</>
                  )}
                  {partnerImportStatus.startsWith('error:') && (
                    <>Hata: {partnerImportStatus.replace('error:', '')}</>
                  )}
                </div>
              )}
            </div>

            <div className="import-info-box" style={{ marginTop: 24 }}>
              <h4>Nasil Calisir?</h4>
              <ul>
                <li>Her isletme icin Google'da arama yapilir</li>
                <li>Bilgi panelinden telefon, web sitesi, adres ve Instagram cekilir</li>
                <li>Veriler Ham Datalar sayfasinda gorunur, WhatsApp ile mesaj gonderebilirsiniz</li>
                <li>Arama arasi 3-7 saniye beklenir (insan benzeri davranis)</li>
                <li>Kampanyayi Data Avi sayfasindan duraklat/iptal edebilirsiniz</li>
              </ul>
            </div>
          </div>
        )}

        {page === 'raw-data' && (
          <div className="data-table-container">
            <div className="data-table-header">
              <h2>
                {websiteFilter === 'no-website' ? (
                  <>Web Sitesi Olmayanlar <span className="record-count" style={{ background: '#ef4444' }}>{filteredBusinesses.length} kayit</span></>
                ) : selectedCampaignData ? (
                  <>
                    {selectedCampaignData.name}
                    <span className="record-count">{filteredBusinesses.length} kayit</span>
                  </>
                ) : (
                  <>Tum Veriler <span className="record-count">{filteredBusinesses.length} kayit</span></>
                )}
              </h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {!selectedCampaignData && (
                  <select
                    className="campaign-filter-select"
                    value={campaignFilter}
                    onChange={e => handleCampaignFilterChange(e.target.value)}
                  >
                    <option value="all">Tum Kampanyalar</option>
                    {campaigns.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
                <div className="filter-tabs">
                  <button className={`filter-tab ${websiteFilter === 'all' ? 'active' : ''}`} onClick={() => setWebsiteFilter('all')}>
                    Tumu ({currentBusinesses.length})
                  </button>
                  <button className={`filter-tab no-site ${websiteFilter === 'no-website' ? 'active' : ''}`} onClick={() => setWebsiteFilter('no-website')}>
                    Sitesi Yok ({noWebsiteCount})
                  </button>
                  <button className={`filter-tab has-site ${websiteFilter === 'has-website' ? 'active' : ''}`} onClick={() => setWebsiteFilter('has-website')}>
                    Sitesi Var ({hasWebsiteCount})
                  </button>
                </div>
                <input
                  className="search-input"
                  placeholder="Ara..."
                  value={dataSearch}
                  onChange={e => setDataSearch(e.target.value)}
                />
                {selectedCampaignData && (
                  <button className="btn btn-sm btn-primary" onClick={() => exportCampaign(selectedCampaignData.id, websiteFilter !== 'all' ? websiteFilter : undefined)}>
                    Excel Indir {websiteFilter === 'no-website' ? '(Sitesi Yok)' : ''}
                  </button>
                )}
              </div>
            </div>

            {/* WhatsApp message bar */}
            {showWpPanel && (
              <div className="wp-panel">
                <div className="wp-panel-header">
                  <h3>WhatsApp Mesaj Sablonu</h3>
                  <button className="btn-icon" onClick={() => setShowWpPanel(false)}>&#10005;</button>
                </div>
                <textarea
                  className="wp-textarea"
                  placeholder={"Merhaba {isletme},\n\nSize ozel bir teklifimiz var...\n\nKullanilabilir degiskenler: {isletme}, {telefon}, {adres}, {kategori}"}
                  value={wpMessage}
                  onChange={e => saveWpMessage(e.target.value)}
                  rows={4}
                />
                <div className="wp-panel-info">
                  <span>Degiskenler: <code>{'{isletme}'}</code> <code>{'{telefon}'}</code> <code>{'{adres}'}</code> <code>{'{kategori}'}</code></span>
                  <span className="wp-sent-count">{wpSentList.size} kisiye gonderildi</span>
                </div>
              </div>
            )}

            <div className="wp-toolbar">
              <button className={`btn btn-sm ${showWpPanel ? 'btn-secondary' : 'btn-whatsapp'}`} onClick={() => setShowWpPanel(!showWpPanel)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                {showWpPanel ? 'Sablonu Gizle' : 'WP Mesaj Ayarla'}
              </button>
              {wpMessage && (
                <span className="wp-ready-badge">Sablon hazir - tablodaki WP butonlarina tiklayin</span>
              )}
            </div>

            <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 220px)' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Isletme Adi</th>
                    <th>Telefon</th>
                    <th>Cep Tel.</th>
                    <th>Web Sitesi</th>
                    <th>E-Posta</th>
                    <th>Adres</th>
                    <th>Puan</th>
                    <th>Yorum</th>
                    <th>Kategori</th>
                    <th>WP</th>
                    <th>Not</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBusinesses.map((b, i) => {
                    const phone = b.phone || b.mobile;
                    const isSent = phone && wpSentList.has(formatPhone(phone));
                    const isEditingNote = editingNoteId === b.id;
                    return (
                      <tr key={b.id || i} className={!b.website ? 'row-no-website' : ''}>
                        <td>{i + 1}</td>
                        <td title={b.name}>{b.name}</td>
                        <td className="phone-cell">{b.phone || ''}</td>
                        <td className="mobile-cell">{b.mobile || ''}</td>
                        <td className="website-cell">
                          {b.website ? <a href={b.website} target="_blank" rel="noreferrer">{b.website.substring(0, 25)}...</a> : <span className="no-website-badge">Sitesi Yok</span>}
                        </td>
                        <td className="email-cell">{b.email || ''}</td>
                        <td title={b.address}>{b.address ? b.address.substring(0, 30) + '...' : ''}</td>
                        <td>{b.rating > 0 ? `${b.rating}` : ''}</td>
                        <td>{b.review_count || ''}</td>
                        <td>{b.category || ''}</td>
                        <td>
                          {phone ? (
                            <button
                              className={`wp-send-btn ${isSent ? 'wp-sent' : ''}`}
                              onClick={() => sendWhatsApp(b)}
                              title={isSent ? 'Gonderildi - tekrar gonder' : 'WhatsApp ile mesaj gonder'}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                              {isSent ? 'Gonderildi' : 'Gonder'}
                            </button>
                          ) : (
                            <span style={{ color: '#94a3b8', fontSize: 12 }}>Tel yok</span>
                          )}
                        </td>
                        <td className="note-cell" style={{ minWidth: 140, maxWidth: 200 }}>
                          {isEditingNote ? (
                            <div className="note-edit-popup">
                              <div className="note-presets">
                                {['Arandi', 'Ilgileniyor', 'Teklif Gonderildi', 'Reddetti', 'Ulasilamadi'].map(preset => (
                                  <button key={preset} className="note-preset-chip" onClick={() => setEditingNoteText(preset)}>{preset}</button>
                                ))}
                              </div>
                              <textarea
                                className="note-textarea"
                                value={editingNoteText}
                                onChange={e => setEditingNoteText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(b.id, editingNoteText); } if (e.key === 'Escape') setEditingNoteId(null); }}
                                autoFocus
                                rows={2}
                                placeholder="Not ekle..."
                              />
                              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                                <button className="btn btn-sm btn-primary" style={{ flex: 1, fontSize: 11, padding: '4px 8px' }} onClick={() => saveNote(b.id, editingNoteText)}>Kaydet</button>
                                <button className="btn btn-sm btn-secondary" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setEditingNoteId(null)}>Iptal</button>
                              </div>
                            </div>
                          ) : (
                            <div
                              className="note-display"
                              onClick={() => { setEditingNoteId(b.id); setEditingNoteText(b.notes || ''); }}
                              title={b.notes || 'Not eklemek icin tiklayin'}
                            >
                              {b.notes ? (
                                <span className="note-text">{b.notes}</span>
                              ) : (
                                <span className="note-empty">+ Not</span>
                              )}
                              <svg className="note-edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredBusinesses.length === 0 && (
                <div className="empty-state">
                  <p>Henuz veri yok. Kampanya calistirarak veri toplayin.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* WhatsApp dedicated page */}
        {page === 'whatsapp' && (
          <div>
            <h2 style={{ marginBottom: 20 }}>WhatsApp Mesaj Merkezi</h2>

            <div className="campaign-form">
              <h2 style={{ fontSize: 16 }}>Mesaj Sablonu</h2>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                Asagidaki sablonu yazin. Degiskenler otomatik olarak isletme bilgileriyle degistirilir.
              </p>
              <textarea
                className="wp-textarea"
                placeholder={"Merhaba {isletme},\n\nIsletmeniz icin profesyonel bir web sitesi olusturmak ister misiniz?\n\nDetayli bilgi icin bize ulasin.\n\nKullanilabilir degiskenler: {isletme}, {telefon}, {adres}, {kategori}"}
                value={wpMessage}
                onChange={e => saveWpMessage(e.target.value)}
                rows={6}
              />
              <div className="wp-panel-info" style={{ marginTop: 8 }}>
                <span>Degiskenler: <code>{'{isletme}'}</code> <code>{'{telefon}'}</code> <code>{'{adres}'}</code> <code>{'{kategori}'}</code></span>
              </div>
            </div>

            <div className="dashboard-stats" style={{ marginTop: 20 }}>
              <div className="stat-card">
                <h3>Gonderilen Mesaj</h3>
                <div className="value" style={{ color: '#25d366' }}>{wpSentList.size}</div>
              </div>
              <div className="stat-card">
                <h3>Telefonlu Isletme</h3>
                <div className="value">{Object.values(businesses).flat().filter(b => b.phone || b.mobile).length}</div>
              </div>
              <div className="stat-card">
                <h3>Sitesiz + Telefonlu</h3>
                <div className="value" style={{ color: '#ef4444' }}>{Object.values(businesses).flat().filter(b => !b.website && (b.phone || b.mobile)).length}</div>
              </div>
            </div>

            {wpMessage && (
              <div className="wp-preview" style={{ marginTop: 20 }}>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>Mesaj Onizleme</h3>
                <div className="wp-bubble">
                  {wpMessage
                    .replace(/\{isletme\}/gi, 'Ornek Isletme')
                    .replace(/\{telefon\}/gi, '0532 123 45 67')
                    .replace(/\{adres\}/gi, 'Istanbul, Kadikoy')
                    .replace(/\{kategori\}/gi, 'Restoran')
                  }
                </div>
              </div>
            )}

            <div style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 16 }}>Hizli Gonder (Sitesi Olmayanlar)</h3>
                {wpSentList.size > 0 && (
                  <button className="btn btn-sm btn-secondary" onClick={() => { setWpSentList(new Set()); localStorage.removeItem('pusula_wp_sent'); }}>
                    Gonderi Gecmisini Temizle
                  </button>
                )}
              </div>
              <div className="data-table-container">
                <div style={{ overflowX: 'auto', maxHeight: 400 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Isletme Adi</th>
                        <th>Telefon</th>
                        <th>Kategori</th>
                        <th>Adres</th>
                        <th>Durum</th>
                        <th>Gonder</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.values(businesses).flat()
                        .filter(b => !b.website && (b.phone || b.mobile))
                        .map((b, i) => {
                          const phone = b.phone || b.mobile;
                          const isSent = wpSentList.has(formatPhone(phone));
                          return (
                            <tr key={b.id || i}>
                              <td>{i + 1}</td>
                              <td>{b.name}</td>
                              <td className="phone-cell">{phone}</td>
                              <td>{b.category || ''}</td>
                              <td title={b.address}>{b.address ? b.address.substring(0, 25) + '...' : ''}</td>
                              <td>
                                {isSent ? (
                                  <span className="wp-status-sent">Gonderildi</span>
                                ) : (
                                  <span className="wp-status-pending">Bekliyor</span>
                                )}
                              </td>
                              <td>
                                <button
                                  className={`wp-send-btn ${isSent ? 'wp-sent' : ''}`}
                                  onClick={() => sendWhatsApp(b)}
                                  disabled={!wpMessage}
                                  title={!wpMessage ? 'Once mesaj sablonu yazin' : ''}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                  {isSent ? 'Tekrar' : 'Gonder'}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
