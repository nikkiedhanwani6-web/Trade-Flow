/* ============================================================
   TRADEFLOW — app.js
   Full business logic, data model, and rendering engine
   All data persisted to localStorage
   ============================================================ */
'use strict';

// ─────────────────────────────────────────────────────────────
// CONSTANTS & ENUMS
// ─────────────────────────────────────────────────────────────
const DB_KEY = 'tradeflow_v1';

const INV_STATUS  = { DRAFT:'Draft', ISSUED:'Issued', PARTIAL:'Partially Paid', PAID:'Paid', OVERDUE:'Overdue' };
const SHIP_STATUS = { PENDING:'Pending', RELEASED:'Released', DELIVERED:'Delivered' };
const PAY_MODE    = ['Bank Transfer','Cash','Cheque','LC','Other'];
const SHIP_MODE   = ['Sea','Air','Land','Courier'];
const FOLLOW_METHOD = ['Call','Email','WhatsApp','Meeting','Other'];
const FOLLOW_STATUS = ['Pending','Done','Scheduled'];
const SVC_TYPES   = ['Customs Clearance','Ocean Freight','Air Freight','Logistics/Transport','Inspection','Testing','Certification','Other'];
const DOC_TYPES   = ['Copy of Invoice','Bill of Lading','Packing List','AZO Certificate','Certificate of Origin','Phytosanitary Certificate','Fumigation Certificate','Sample Dispatch Proof','Courier Receipt','Other'];
const DISPATCH_MODE = ['Email','Courier','Hand Delivery','Other'];
const PAY_TERMS   = ['Advance','CAD','Net 30','Net 45','Net 60','Net 90','LC at Sight','Usance 60','Usance 90','Custom'];
const CURRENCIES  = ['USD','EUR','GBP','INR','AED','CNY','SGD','JPY','AUD','CAD'];

// ─────────────────────────────────────────────────────────────
// DATA STORE
// ─────────────────────────────────────────────────────────────
let DB = { buyers:[], invoices:[], shipments:[], payments:[], documents:[], dispatches:[], services:[], followups:[], samples:[], releases:[] };

function saveDB() { localStorage.setItem(DB_KEY, JSON.stringify(DB)); }
function loadDB() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) { try { DB = JSON.parse(raw); return; } catch(e){} }
  seedData();
}
const uid = () => '_' + Math.random().toString(36).slice(2,11);
const today = () => new Date().toISOString().split('T')[0];
const daysDiff = (d) => { if(!d) return null; const diff = Math.floor((Date.now()-new Date(d))/(1000*60*60*24)); return diff; };
const daysUntil = (d) => { if(!d) return null; return Math.ceil((new Date(d)-Date.now())/(1000*60*60*24)); };
const fmtDate = (d) => { if(!d) return '—'; return new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); };
const fmtAmt = (n, cur='USD') => { if(n===null||n===undefined) return '—'; return cur+' '+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
const esc = s => { const d=document.createElement('div'); d.appendChild(document.createTextNode(s||'')); return d.innerHTML; };

// ─────────────────────────────────────────────────────────────
// BUSINESS LOGIC CALCULATIONS
// ─────────────────────────────────────────────────────────────

/* 1. Sum all payments for an invoice (in invoice currency using exchange rate) */
function invoiceTotalPaid(invId) {
  return DB.payments
    .filter(p => p.invoiceId === invId)
    .reduce((s, p) => s + (p.amountInInvCurrency || p.amount), 0);
}

/* 2. Outstanding = invoice amount - total paid */
function invoiceOutstanding(inv) {
  const paid = invoiceTotalPaid(inv.id);
  return Math.max(0, inv.amount - paid);
}

/* 3. Invoice payment status (computed, not stored) */
function computeInvoiceStatus(inv) {
  if (inv.status === 'Draft') return 'Draft';
  const paid = invoiceTotalPaid(inv.id);
  const outstanding = inv.amount - paid;
  if (outstanding <= 0) return 'Paid';
  if (paid > 0) return 'Partially Paid';
  if (inv.dueDate && new Date(inv.dueDate) < new Date()) return 'Overdue';
  return 'Issued';
}

/* 4. Buyer totals across all invoices + services */
function buyerTotals(buyerId) {
  const invs = DB.invoices.filter(i => i.buyerId === buyerId);
  const svcs = DB.services.filter(s => s.buyerId === buyerId);
  const totalInvoiced = invs.reduce((s,i) => s + i.amount, 0);
  const totalServices = svcs.reduce((s,v) => s + v.amount, 0);
  const totalPaid = invs.reduce((s,i) => s + invoiceTotalPaid(i.id), 0);
  const totalOutstanding = invs.reduce((s,i) => s + invoiceOutstanding(i), 0);
  const overdue = invs.filter(i => computeInvoiceStatus(i) === 'Overdue').reduce((s,i) => s + invoiceOutstanding(i), 0);
  return { totalInvoiced, totalServices, totalPaid, totalOutstanding, overdue, invoiceCount: invs.length };
}

/* 5. Release status for a shipment */
function computeReleaseStatus(rel) {
  if (!rel) return 'Pending';
  if (rel.deliveryDate || rel.goodsReleaseDate) return 'Delivered';
  if (rel.telexReleaseDate) return 'Released';
  return 'Pending';
}

/* 6. Aging buckets based on dueDate vs today */
function agingBucket(inv) {
  if (computeInvoiceStatus(inv) === 'Paid') return null;
  if (!inv.dueDate) return null;
  const days = daysDiff(inv.dueDate);
  if (days <= 0) return null; // not yet due
  if (days <= 30) return 0;
  if (days <= 60) return 1;
  if (days <= 90) return 2;
  return 3;
}

/* 7. Global dashboard stats */
function dashStats() {
  const totalBuyers = DB.buyers.length;
  const totalInvoices = DB.invoices.length;
  const totalInvoiced = DB.invoices.reduce((s,i)=>s+i.amount,0);
  const totalPaid = DB.invoices.reduce((s,i)=>s+invoiceTotalPaid(i.id),0);
  const totalOutstanding = DB.invoices.reduce((s,i)=>s+invoiceOutstanding(i),0);
  const overdueInvs = DB.invoices.filter(i => computeInvoiceStatus(i)==='Overdue');
  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate()+7);
  const monthEnd = new Date(now); monthEnd.setDate(monthEnd.getDate()+30);
  const dueThisWeek = DB.invoices.filter(i => {
    if (computeInvoiceStatus(i)==='Paid') return false;
    if (!i.dueDate) return false;
    const d = new Date(i.dueDate);
    return d >= now && d <= weekEnd;
  });
  const dueThisMonth = DB.invoices.filter(i => {
    if (computeInvoiceStatus(i)==='Paid') return false;
    if (!i.dueDate) return false;
    const d = new Date(i.dueDate);
    return d >= now && d <= monthEnd;
  });
  return { totalBuyers, totalInvoices, totalInvoiced, totalPaid, totalOutstanding, overdueInvs, dueThisWeek, dueThisMonth };
}

// ─────────────────────────────────────────────────────────────
// SEED DATA — Buyer A fabric example + more
// ─────────────────────────────────────────────────────────────
function seedData() {
  const b1 = uid(), b2 = uid(), b3 = uid();
  const i1 = uid(), i2 = uid(), i3 = uid(), i4 = uid();
  const s1 = uid(), s2 = uid();
  const r1 = uid(), r2 = uid();

  DB.buyers = [
    { id:b1, company:'Al-Faris Trading LLC', contact:'Ahmed Al-Faris', email:'ahmed@alfaris.ae', phone:'+971-50-123-4567', whatsapp:'+971-50-123-4567', country:'UAE', address:'Deira, Dubai, UAE', payTerms:'Net 30', currency:'USD', notes:'Premium buyer. Prefers sea freight. Pay via bank transfer.' },
    { id:b2, company:'Textiles Europe GmbH', contact:'Hans Mueller', email:'hans@texeu.de', phone:'+49-30-8876543', whatsapp:'', country:'Germany', address:'Hamburg, Germany', payTerms:'Net 45', currency:'EUR', notes:'Requests AZO certificate on all fabric orders.' },
    { id:b3, company:'Pacific Garments Co.', contact:'Li Wei', email:'liwei@pacgarments.cn', phone:'+86-21-5551234', whatsapp:'+86-21-5551234', country:'China', address:'Shanghai, China', payTerms:'CAD', currency:'USD', notes:'CAD terms, documents against payment.' },
  ];

  DB.invoices = [
    { id:i1, buyerId:b1, invoiceNo:'INV-2025-001', product:'Cotton Fabric (100m rolls)', description:'280 gsm cotton twill fabric, natural color, 100m rolls x 50 nos', date:'2025-01-10', dueDate:'2025-02-09', amount:12500, currency:'USD', payTerms:'Net 30', status:'Issued', notes:'Dispatch before Jan 20. Buyer needs AZO cert.' },
    { id:i2, buyerId:b1, invoiceNo:'INV-2025-002', product:'Polyester Blend Fabric', description:'Poly-cotton 60/40 blend, 150m rolls x 20 nos', date:'2025-02-01', dueDate:'2025-03-03', amount:8200, currency:'USD', payTerms:'Net 30', status:'Issued', notes:'Follow up for second advance.' },
    { id:i3, buyerId:b2, invoiceNo:'INV-2025-003', product:'Organic Cotton Fabric', description:'GOTS certified organic cotton, 200m x 30 nos', date:'2025-01-20', dueDate:'2025-03-05', amount:18750, currency:'EUR', payTerms:'Net 45', status:'Issued', notes:'AZO cert mandatory. Include GOTS certificate.' },
    { id:i4, buyerId:b3, invoiceNo:'INV-2025-004', product:'Denim Fabric', description:'14oz denim indigo, 100m rolls x 40 nos', date:'2025-02-10', dueDate:'2025-02-10', amount:22000, currency:'USD', payTerms:'CAD', status:'Issued', notes:'CAD terms. Documents to bank on shipment.' },
  ];

  DB.shipments = [
    { id:s1, buyerId:b1, invoiceId:i1, shipmentNo:'SHP-2025-001', date:'2025-01-18', mode:'Sea', vessel:'MSC Harmony', voyageNo:'V-245', containerNo:'MSCU7312840', portLoading:'Mundra, India', portDischarge:'Jebel Ali, UAE', etd:'2025-01-18', eta:'2025-01-28', notes:'20ft container, CIF terms' },
    { id:s2, buyerId:b2, invoiceId:i3, shipmentNo:'SHP-2025-002', date:'2025-01-25', mode:'Sea', vessel:'CMA CGM Marco Polo', voyageNo:'V-112', containerNo:'CMAU8441200', portLoading:'JNPT Mumbai, India', portDischarge:'Hamburg, Germany', etd:'2025-01-25', eta:'2025-02-18', notes:'FCL 20ft. Reefer not required.' },
  ];

  DB.releases = [
    { id:r1, shipmentId:s1, telexReleaseDate:'2025-01-30', goodsReleaseDate:'2025-02-02', deliveryDate:'2025-02-03', notes:'Telex released on buyer payment confirmation.' },
    { id:r2, shipmentId:s2, telexReleaseDate:'2025-02-19', goodsReleaseDate:null, deliveryDate:null, notes:'Awaiting buyer\'s customs clearance.' },
  ];

  DB.payments = [
    // INV-001 partial payments
    { id:uid(), buyerId:b1, invoiceId:i1, date:'2025-01-08', amount:5000, amountInInvCurrency:5000, currency:'USD', exchangeRate:1, placeReceived:'Dubai / Emirates NBD', mode:'Bank Transfer', ref:'TT/2025/0041', notes:'First advance payment', fileRef:null },
    { id:uid(), buyerId:b1, invoiceId:i1, date:'2025-02-05', amount:4000, amountInInvCurrency:4000, currency:'USD', exchangeRate:1, placeReceived:'Dubai / Emirates NBD', mode:'Bank Transfer', ref:'TT/2025/0089', notes:'Second installment', fileRef:null },
    // INV-003 partial
    { id:uid(), buyerId:b2, invoiceId:i3, date:'2025-01-18', amount:9375, amountInInvCurrency:9375, currency:'EUR', exchangeRate:1, placeReceived:'Hamburg / Deutsche Bank', mode:'Bank Transfer', ref:'DE-TT-20250118', notes:'50% advance as per terms', fileRef:null },
    // INV-004 no payment yet
  ];

  DB.documents = [
    { id:uid(), buyerId:b1, invoiceId:i1, shipmentId:s1, type:'Copy of Invoice', name:'Invoice INV-2025-001.pdf', uploadDate:'2025-01-10', fileRef:'inv_001.pdf', notes:'' },
    { id:uid(), buyerId:b1, invoiceId:i1, shipmentId:s1, type:'Bill of Lading', name:'BL-SHP-2025-001.pdf', uploadDate:'2025-01-20', fileRef:'bl_001.pdf', notes:'Original BL' },
    { id:uid(), buyerId:b1, invoiceId:i1, shipmentId:s1, type:'Packing List', name:'PackingList-001.pdf', uploadDate:'2025-01-20', fileRef:'pl_001.pdf', notes:'' },
    { id:uid(), buyerId:b1, invoiceId:i1, shipmentId:s1, type:'AZO Certificate', name:'AZO-Cert-001.pdf', uploadDate:'2025-01-15', fileRef:'azo_001.pdf', notes:'Issued by SGS India' },
    { id:uid(), buyerId:b2, invoiceId:i3, shipmentId:s2, type:'Copy of Invoice', name:'Invoice INV-2025-003.pdf', uploadDate:'2025-01-20', fileRef:'inv_003.pdf', notes:'' },
    { id:uid(), buyerId:b2, invoiceId:i3, shipmentId:s2, type:'Bill of Lading', name:'BL-SHP-2025-002.pdf', uploadDate:'2025-01-26', fileRef:'bl_002.pdf', notes:'' },
    { id:uid(), buyerId:b2, invoiceId:i3, shipmentId:s2, type:'AZO Certificate', name:'AZO-Cert-003.pdf', uploadDate:'2025-01-20', fileRef:'azo_003.pdf', notes:'' },
  ];

  DB.dispatches = [
    { id:uid(), buyerId:b1, invoiceId:i1, shipmentId:s1, date:'2025-01-22', mode:'Email', trackingRef:'', notes:'Sent all documents via email. Buyer confirmed receipt.', docsSent:['Copy of Invoice','Bill of Lading','Packing List','AZO Certificate'] },
    { id:uid(), buyerId:b2, invoiceId:i3, shipmentId:s2, date:'2025-01-27', mode:'Courier', trackingRef:'DHL-7823991', notes:'Original BL dispatched via DHL courier.', docsSent:['Bill of Lading','AZO Certificate'] },
  ];

  DB.services = [
    { id:uid(), buyerId:b1, invoiceId:i1, type:'Customs Clearance', desc:'Customs clearance at Jebel Ali, UAE', amount:320, currency:'USD', date:'2025-02-03', vendor:'Global Customs Dubai', ref:'CC/JA/2025/112', notes:'', fileRef:null },
    { id:uid(), buyerId:b1, invoiceId:i1, type:'Ocean Freight', desc:'Ocean freight Mundra to Jebel Ali', amount:850, currency:'USD', date:'2025-01-18', vendor:'MSC Shipping', ref:'MSC-FR-2025-041', notes:'CIF included in invoice but shown separately', fileRef:null },
    { id:uid(), buyerId:b1, invoiceId:i1, type:'Logistics/Transport', desc:'Inland transport Jebel Ali to buyer warehouse', amount:180, currency:'USD', date:'2025-02-04', vendor:'Al Futtaim Logistics', ref:'AFL-2025-0231', notes:'', fileRef:null },
    { id:uid(), buyerId:b2, invoiceId:i3, type:'Ocean Freight', desc:'FCL freight Mumbai to Hamburg', amount:2100, currency:'EUR', date:'2025-01-25', vendor:'CMA CGM', ref:'CMACGM-BK-112', notes:'', fileRef:null },
  ];

  DB.followups = [
    { id:uid(), buyerId:b1, invoiceId:i1, date:'2025-01-25', method:'WhatsApp', notes:'Confirmed shipment. Buyer asked for BL copy.', nextDate:'2025-02-05', status:'Done' },
    { id:uid(), buyerId:b1, invoiceId:i1, date:'2025-02-05', method:'Email', notes:'Sent statement of account. Requested balance payment of USD 3,500.', nextDate:'2025-02-12', status:'Pending' },
    { id:uid(), buyerId:b1, invoiceId:i2, date:'2025-02-03', method:'Call', notes:'Buyer confirmed he will pay by Feb 15.', nextDate:'2025-02-15', status:'Scheduled' },
    { id:uid(), buyerId:b2, invoiceId:i3, date:'2025-02-01', method:'Email', notes:'Sent documents dispatch confirmation and tracking.', nextDate:'2025-02-20', status:'Scheduled' },
  ];

  DB.samples = [
    { id:uid(), buyerId:b1, invoiceId:i1, dateSent:'2024-12-20', courier:'FedEx International', trackingRef:'FX-7712394', notes:'3 swatches sent for pre-shipment approval', fileRef:null },
    { id:uid(), buyerId:b2, invoiceId:i3, dateSent:'2024-12-28', courier:'DHL Express', trackingRef:'DHL-5519283', notes:'Organic cotton sample + test report', fileRef:null },
  ];

  saveDB();
}

// ─────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let currentBuyerId = null;
let currentInvoiceId = null;

function nav(page, params={}) {
  currentPage = page;
  if (params.buyerId) currentBuyerId = params.buyerId;
  if (params.invoiceId) currentInvoiceId = params.invoiceId;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pg = document.getElementById('page-'+page);
  if (pg) pg.classList.add('active');
  const ni = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (ni) ni.classList.add('active');
  const renders = {
    dashboard:    renderDashboard,
    buyers:       renderBuyers,
    'buyer-detail': ()=>renderBuyerDetail(currentBuyerId),
    invoices:     renderInvoices,
    'invoice-detail': ()=>renderInvoiceDetail(currentInvoiceId),
    shipments:    renderShipments,
    payments:     renderPayments,
    documents:    renderDocuments,
    followups:    renderFollowups,
    aging:        renderAging,
    services:     renderServices,
  };
  if (renders[page]) renders[page]();
  document.querySelector('.content')?.scrollTo(0,0);
}

function openBuyer(id)   { nav('buyer-detail',{buyerId:id}); }
function openInvoice(id) { nav('invoice-detail',{invoiceId:id}); }

// ─────────────────────────────────────────────────────────────
// HELPER RENDERERS
// ─────────────────────────────────────────────────────────────
function setHTML(id,html){ const e=document.getElementById(id); if(e) e.innerHTML=html; }

function badgeStatus(status) {
  const map = {
    'Draft':'b-gray','Issued':'b-blue','Partially Paid':'b-amber','Paid':'b-green','Overdue':'b-red',
    'Pending':'b-amber','Released':'b-sky','Delivered':'b-green',
    'Done':'b-green','Scheduled':'b-blue',
  };
  return `<span class="badge ${map[status]||'b-gray'}">${esc(status)}</span>`;
}

function buyerName(id){ const b=DB.buyers.find(x=>x.id===id); return b?b.company:'Unknown'; }
function invoiceNo(id){ const i=DB.invoices.find(x=>x.id===id); return i?i.invoiceNo:'—'; }

// ─────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────
function renderDashboard() {
  const st = dashStats();
  setHTML('dash-stats', `
    <div class="stat-card"><div class="s-icon">🏢</div><div class="s-val">${st.totalBuyers}</div><div class="s-label">Total Buyers</div></div>
    <div class="stat-card"><div class="s-icon">📄</div><div class="s-val">${st.totalInvoices}</div><div class="s-label">Total Invoices</div></div>
    <div class="stat-card info"><div class="s-icon">💰</div><div class="s-val">${fmtAmt(st.totalInvoiced,'USD')}</div><div class="s-label">Total Invoiced</div><div class="s-sub">Across all buyers</div></div>
    <div class="stat-card success"><div class="s-icon">✅</div><div class="s-val">${fmtAmt(st.totalPaid,'USD')}</div><div class="s-label">Total Collected</div></div>
    <div class="stat-card danger"><div class="s-icon">⏳</div><div class="s-val">${fmtAmt(st.totalOutstanding,'USD')}</div><div class="s-label">Total Outstanding</div></div>
    <div class="stat-card danger"><div class="s-icon">🔴</div><div class="s-val">${st.overdueInvs.length}</div><div class="s-label">Overdue Invoices</div></div>
    <div class="stat-card warning"><div class="s-icon">📅</div><div class="s-val">${st.dueThisWeek.length}</div><div class="s-label">Due This Week</div></div>
    <div class="stat-card warning"><div class="s-icon">🗓</div><div class="s-val">${st.dueThisMonth.length}</div><div class="s-label">Due This Month</div></div>
  `);

  // Overdue alerts
  let overdueHtml = '';
  if (st.overdueInvs.length) {
    overdueHtml = st.overdueInvs.map(i=>`
      <div class="alert-strip danger" style="cursor:pointer" onclick="openInvoice('${i.id}')">
        <span class="alert-icon">🔴</span>
        <div class="alert-body">
          <div class="alert-title">${esc(i.invoiceNo)} — ${esc(buyerName(i.buyerId))}</div>
          <div class="alert-sub">Outstanding: ${fmtAmt(invoiceOutstanding(i), i.currency)} · Due: ${fmtDate(i.dueDate)} · ${daysDiff(i.dueDate)} days overdue</div>
        </div>
        <span class="badge b-red">${fmtAmt(invoiceOutstanding(i),i.currency)}</span>
      </div>`).join('');
  } else {
    overdueHtml = `<div class="alert-strip success"><span class="alert-icon">✅</span><div class="alert-body"><div class="alert-title">No overdue invoices</div></div></div>`;
  }
  setHTML('dash-overdue', overdueHtml);

  // Outstanding by buyer
  let buyerOut = DB.buyers.map(b => {
    const t = buyerTotals(b.id);
    return { b, t };
  }).filter(x=>x.t.totalOutstanding>0).sort((a,b)=>b.t.totalOutstanding-a.t.totalOutstanding);
  setHTML('dash-buyer-out', buyerOut.length ? buyerOut.map(({b,t})=>`
    <tr>
      <td class="fw" style="cursor:pointer" onclick="openBuyer('${b.id}')">${esc(b.company)}</td>
      <td>${esc(b.country)}</td>
      <td>${t.invoiceCount}</td>
      <td class="amount credit">${fmtAmt(t.totalInvoiced,'USD')}</td>
      <td class="amount neutral">${fmtAmt(t.totalPaid,'USD')}</td>
      <td class="amount debit">${fmtAmt(t.totalOutstanding,'USD')}</td>
      <td>${fmtAmt(t.overdue,'USD')?`<span class="badge b-red">${fmtAmt(t.overdue,'USD')}</span>`:''}</td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="text-muted" style="padding:20px;text-align:center">All invoices settled ✓</td></tr>`
  );

  // Recent payments
  const recPay = [...DB.payments].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  setHTML('dash-recent-pay', recPay.map(p=>`
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td style="cursor:pointer" onclick="openBuyer('${p.buyerId}')" class="fw">${esc(buyerName(p.buyerId))}</td>
      <td class="mono" style="cursor:pointer" onclick="openInvoice('${p.invoiceId}')">${esc(invoiceNo(p.invoiceId))}</td>
      <td class="amount credit">${fmtAmt(p.amount,p.currency)}</td>
      <td>${esc(p.mode)}</td>
      <td class="mono text-muted">${esc(p.ref||'—')}</td>
    </tr>`).join('')
  );

  // Recent followups
  const recFU = [...DB.followups].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  setHTML('dash-followups', recFU.map(f=>`
    <tr>
      <td>${fmtDate(f.date)}</td>
      <td style="cursor:pointer" onclick="openBuyer('${f.buyerId}')" class="fw">${esc(buyerName(f.buyerId))}</td>
      <td>${f.invoiceId?`<span class="mono" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${f.invoiceId}')">${esc(invoiceNo(f.invoiceId))}</span>`:'—'}</td>
      <td><span class="chip">${esc(f.method)}</span></td>
      <td class="text-muted">${esc(f.notes||'').slice(0,60)}${(f.notes||'').length>60?'…':''}</td>
      <td>${badgeStatus(f.status)}</td>
      <td>${fmtDate(f.nextDate)}</td>
    </tr>`).join('')
  );

  // Aging summary
  const buckets = [0,0,0,0];
  DB.invoices.forEach(i => {
    const b = agingBucket(i);
    if (b !== null) buckets[b] += invoiceOutstanding(i);
  });
  setHTML('dash-aging', `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
      <div class="stat-card success"><div class="s-label">0–30 Days</div><div class="s-val aging-bucket-0">${fmtAmt(buckets[0],'USD')}</div></div>
      <div class="stat-card warning"><div class="s-label">31–60 Days</div><div class="s-val aging-bucket-1">${fmtAmt(buckets[1],'USD')}</div></div>
      <div class="stat-card warning"><div class="s-label">61–90 Days</div><div class="s-val aging-bucket-2">${fmtAmt(buckets[2],'USD')}</div></div>
      <div class="stat-card danger"><div class="s-label">90+ Days</div><div class="s-val aging-bucket-3">${fmtAmt(buckets[3],'USD')}</div></div>
    </div>
  `);
}

// ─────────────────────────────────────────────────────────────
// BUYERS LIST
// ─────────────────────────────────────────────────────────────
function renderBuyers(q='') {
  let list = DB.buyers.filter(b=> !q || b.company.toLowerCase().includes(q.toLowerCase()) || b.country.toLowerCase().includes(q.toLowerCase()) || b.contact.toLowerCase().includes(q.toLowerCase()));
  setHTML('buyer-grid', list.length ? list.map(b=>{
    const t = buyerTotals(b.id);
    const initials = b.company.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
    return `<div class="buyer-card" onclick="openBuyer('${b.id}')">
      <div class="bc-header">
        <div style="display:flex;gap:10px;align-items:center">
          <div class="bc-avatar">${initials}</div>
          <div>
            <div class="bc-name">${esc(b.company)}</div>
            <div class="bc-country">🌍 ${esc(b.country)} · ${esc(b.payTerms)}</div>
          </div>
        </div>
        <div>${t.overdue>0?`<span class="badge b-red">Overdue</span>`:''}</div>
      </div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:10px">📧 ${esc(b.email)} · 📱 ${esc(b.phone)}</div>
      <div class="bc-stats">
        <div><div class="bc-stat-val">${t.invoiceCount}</div><div class="bc-stat-label">Invoices</div></div>
        <div><div class="bc-stat-val" style="color:var(--brand)">${fmtAmt(t.totalInvoiced,'USD')}</div><div class="bc-stat-label">Invoiced</div></div>
        <div><div class="bc-stat-val" style="color:${t.totalOutstanding>0?'var(--red)':'var(--green)'}">${fmtAmt(t.totalOutstanding,'USD')}</div><div class="bc-stat-label">Outstanding</div></div>
      </div>
    </div>`;
  }).join('') : `<div class="empty-state"><span class="es-icon">🏢</span><h3>No buyers yet</h3><p>Add your first buyer to get started.</p><button class="btn btn-primary" onclick="openModal('modal-buyer')">+ Add Buyer</button></div>`);
}

// ─────────────────────────────────────────────────────────────
// BUYER DETAIL
// ─────────────────────────────────────────────────────────────
function renderBuyerDetail(id) {
  const b = DB.buyers.find(x=>x.id===id);
  if (!b) return;
  const t = buyerTotals(id);
  const invs = DB.invoices.filter(i=>i.buyerId===id);
  const svcs = DB.services.filter(s=>s.buyerId===id);
  const pays = DB.payments.filter(p=>p.buyerId===id);
  const fups = DB.followups.filter(f=>f.buyerId===id);

  setHTML('bd-header', `
    <div style="display:flex;align-items:center;gap:14px">
      <div class="bc-avatar" style="width:48px;height:48px;font-size:18px">${b.company.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase()}</div>
      <div>
        <h1 style="font-size:20px;font-weight:600">${esc(b.company)}</h1>
        <div style="font-size:12.5px;color:var(--ink3)">🌍 ${esc(b.country)} · 📧 ${esc(b.email)} · 📱 ${esc(b.phone)} · Terms: ${esc(b.payTerms)}</div>
      </div>
    </div>
  `);

  setHTML('bd-stats', `
    <div class="stat-card info"><div class="s-label">Total Invoiced</div><div class="s-val">${fmtAmt(t.totalInvoiced,'USD')}</div></div>
    <div class="stat-card success"><div class="s-label">Total Paid</div><div class="s-val">${fmtAmt(t.totalPaid,'USD')}</div></div>
    <div class="stat-card danger"><div class="s-label">Outstanding</div><div class="s-val">${fmtAmt(t.totalOutstanding,'USD')}</div></div>
    <div class="stat-card warning"><div class="s-label">Services Total</div><div class="s-val">${fmtAmt(t.totalServices,'USD')}</div></div>
    <div class="stat-card ${t.overdue>0?'danger':''}"><div class="s-label">Overdue</div><div class="s-val">${fmtAmt(t.overdue,'USD')}</div></div>
    <div class="stat-card"><div class="s-label">Invoices</div><div class="s-val">${t.invoiceCount}</div></div>
  `);

  // Invoice table
  setHTML('bd-invoices', invs.length ? invs.map(i=>{
    const status = computeInvoiceStatus(i);
    const outstanding = invoiceOutstanding(i);
    const paid = invoiceTotalPaid(i.id);
    return `<tr>
      <td class="mono fw" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${i.id}')">${esc(i.invoiceNo)}</td>
      <td>${fmtDate(i.date)}</td>
      <td>${esc(i.product)}</td>
      <td class="amount neutral">${fmtAmt(i.amount,i.currency)}</td>
      <td class="amount credit">${fmtAmt(paid,i.currency)}</td>
      <td class="amount debit">${fmtAmt(outstanding,i.currency)}</td>
      <td>${fmtDate(i.dueDate)}</td>
      <td>${badgeStatus(status)}</td>
      <td><div class="actions">
        <button class="btn-icon" onclick="openInvoice('${i.id}')" title="View">👁</button>
        <button class="btn-icon" onclick="openPayModal('${i.id}')" title="Add Payment">💳</button>
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="text-muted" style="padding:20px;text-align:center">No invoices. <span style="color:var(--brand);cursor:pointer" onclick="openModal('modal-invoice','${id}')">Create one</span></td></tr>`);

  // Services
  setHTML('bd-services', svcs.length ? svcs.map(s=>`
    <tr>
      <td>${fmtDate(s.date)}</td>
      <td><span class="chip">${esc(s.type)}</span></td>
      <td>${esc(s.desc)}</td>
      <td>${s.invoiceId?`<span class="mono" style="color:var(--brand);cursor:pointer" onclick="openInvoice('${s.invoiceId}')">${esc(invoiceNo(s.invoiceId))}</span>`:'—'}</td>
      <td class="amount debit">${fmtAmt(s.amount,s.currency)}</td>
      <td>${esc(s.vendor||'—')}</td>
      <td class="mono text-muted">${esc(s.ref||'—')}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="text-muted" style="padding:16px;text-align:center">No service charges</td></tr>`);

  // Payments
  setHTML('bd-payments', pays.length ? pays.map(p=>`
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td class="mono" style="color:var(--brand);cursor:pointer" onclick="openInvoice('${p.invoiceId}')">${esc(invoiceNo(p.invoiceId))}</td>
      <td class="amount credit">${fmtAmt(p.amount,p.currency)}</td>
      <td>${esc(p.mode)}</td>
      <td class="mono text-muted">${esc(p.ref||'—')}</td>
      <td class="text-muted">${esc(p.placeReceived||'—')}</td>
      <td class="text-muted">${esc(p.notes||'—')}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="text-muted" style="padding:16px;text-align:center">No payments recorded</td></tr>`);

  // Follow-ups
  renderFollowupTimeline('bd-followups', fups);

  document.getElementById('bd-add-inv-btn').onclick = ()=>openModal('modal-invoice', id);
  document.getElementById('bd-add-pay-btn').onclick = ()=>openPayModal(null, id);
  document.getElementById('bd-add-fu-btn').onclick  = ()=>openModal('modal-followup', id);
  document.getElementById('bd-add-svc-btn').onclick = ()=>openModal('modal-service', id);
  document.getElementById('bd-statement-btn').onclick = ()=>renderStatement(id);
}

function renderFollowupTimeline(containerId, fups) {
  const colors = { Call:'#3B82F6', Email:'#8B5CF6', WhatsApp:'#10B981', Meeting:'#F59E0B', Other:'#6B7280' };
  const sorted = [...fups].sort((a,b)=>b.date.localeCompare(a.date));
  setHTML(containerId, sorted.length ? `<div class="timeline">${sorted.map(f=>`
    <div class="tl-item">
      <div class="tl-dot" style="background:${colors[f.method]||'#6B7280'}">
        ${f.method==='Call'?'📞':f.method==='Email'?'📧':f.method==='WhatsApp'?'💬':f.method==='Meeting'?'🤝':'📌'}
      </div>
      <div class="tl-body">
        <div class="tl-title">${esc(f.method)} Follow-up${f.invoiceId?` · <span style="color:var(--brand)">${esc(invoiceNo(f.invoiceId))}</span>`:''}</div>
        <div class="tl-meta">${fmtDate(f.date)} ${badgeStatus(f.status)} ${f.nextDate?`· Next: ${fmtDate(f.nextDate)}`:''}</div>
        ${f.notes?`<div class="tl-note">${esc(f.notes)}</div>`:''}
      </div>
    </div>`).join('')}</div>`
    : `<div class="text-muted" style="padding:16px">No follow-ups recorded.</div>`);
}

// ─────────────────────────────────────────────────────────────
// INVOICE DETAIL
// ─────────────────────────────────────────────────────────────
function renderInvoiceDetail(id) {
  const inv = DB.invoices.find(x=>x.id===id);
  if (!inv) return;
  const buyer = DB.buyers.find(x=>x.id===inv.buyerId);
  const status = computeInvoiceStatus(inv);
  const paid = invoiceTotalPaid(id);
  const outstanding = invoiceOutstanding(inv);
  const pct = inv.amount > 0 ? Math.min(100, Math.round(paid/inv.amount*100)) : 0;
  const invPayments = DB.payments.filter(p=>p.invoiceId===id);
  const invShipments = DB.shipments.filter(s=>s.invoiceId===id);
  const invDocs = DB.documents.filter(d=>d.invoiceId===id);
  const invDispatches = DB.dispatches.filter(d=>d.invoiceId===id);
  const invSvcs = DB.services.filter(s=>s.invoiceId===id);
  const invFups = DB.followups.filter(f=>f.invoiceId===id);
  const invSamples = DB.samples.filter(s=>s.invoiceId===id);

  setHTML('inv-header', `
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <h1 style="font-size:20px;font-weight:600" class="mono">${esc(inv.invoiceNo)}</h1>
        ${badgeStatus(status)}
      </div>
      <div style="font-size:12.5px;color:var(--ink3)">
        ${esc(inv.product)} · Buyer: <span style="color:var(--brand);cursor:pointer" onclick="openBuyer('${inv.buyerId}')">${esc(buyer?.company||'Unknown')}</span>
      </div>
    </div>
  `);

  setHTML('inv-meter', `
    <div class="pay-meter">
      <div class="pm-row"><span class="pm-label">Invoice Total</span><span class="pm-val">${fmtAmt(inv.amount, inv.currency)}</span></div>
      <div class="pm-row"><span class="pm-label">Total Paid</span><span class="pm-val" style="color:var(--green)">${fmtAmt(paid, inv.currency)}</span></div>
      <div class="pm-row"><span class="pm-label">Outstanding</span><span class="pm-val" style="color:${outstanding>0?'var(--red)':'var(--green)'}">${fmtAmt(outstanding, inv.currency)}</span></div>
      <div class="progress-bar" style="margin-top:8px"><div class="progress-fill" style="width:${pct}%;background:${pct===100?'var(--green)':'var(--brand)'}"></div></div>
      <div style="font-size:11px;color:var(--ink4);margin-top:4px;text-align:right">${pct}% collected</div>
    </div>
  `);

  setHTML('inv-info', `
    <div class="info-grid">
      <div class="info-item"><div class="ii-label">Invoice No</div><div class="ii-val mono">${esc(inv.invoiceNo)}</div></div>
      <div class="info-item"><div class="ii-label">Invoice Date</div><div class="ii-val">${fmtDate(inv.date)}</div></div>
      <div class="info-item"><div class="ii-label">Due Date</div><div class="ii-val">${fmtDate(inv.dueDate)}</div></div>
      <div class="info-item"><div class="ii-label">Payment Terms</div><div class="ii-val">${esc(inv.payTerms)}</div></div>
      <div class="info-item"><div class="ii-label">Currency</div><div class="ii-val">${esc(inv.currency)}</div></div>
      <div class="info-item"><div class="ii-label">Buyer</div><div class="ii-val" style="color:var(--brand);cursor:pointer" onclick="openBuyer('${inv.buyerId}')">${esc(buyer?.company||'')}</div></div>
    </div>
    ${inv.description?`<div style="margin-top:12px;font-size:13px;color:var(--ink2)"><strong>Description:</strong> ${esc(inv.description)}</div>`:''}
    ${inv.notes?`<div style="margin-top:6px;font-size:12.5px;color:var(--ink3)">📝 ${esc(inv.notes)}</div>`:''}
  `);

  // Payments table
  setHTML('inv-payments', invPayments.length ? invPayments.map(p=>`
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td class="amount credit">${fmtAmt(p.amount,p.currency)}</td>
      <td>${p.currency !== inv.currency ? `<span class="text-muted">(${fmtAmt(p.amountInInvCurrency,inv.currency)} ${inv.currency})</span>` : ''}</td>
      <td>${esc(p.mode)}</td>
      <td class="mono text-muted">${esc(p.ref||'—')}</td>
      <td class="text-muted">${esc(p.placeReceived||'—')}</td>
      <td class="text-muted">${esc(p.notes||'—')}</td>
      <td><div class="actions"><button class="btn-icon" style="color:var(--red)" onclick="deleteRecord('payments','${p.id}','inv-payments',()=>renderInvoiceDetail('${id}'))">🗑</button></div></td>
    </tr>`).join('')
    : `<tr><td colspan="8" class="text-muted" style="padding:16px;text-align:center">No payments yet</td></tr>`);

  // Shipments
  setHTML('inv-shipments', invShipments.length ? invShipments.map(s=>{
    const rel = DB.releases.find(r=>r.shipmentId===s.id);
    const relStatus = computeReleaseStatus(rel);
    return `<tr>
      <td class="mono fw">${esc(s.shipmentNo)}</td>
      <td>${fmtDate(s.date)}</td>
      <td><span class="chip">${esc(s.mode)}</span></td>
      <td class="text-muted">${esc(s.containerNo||'—')}</td>
      <td class="text-muted">${esc(s.portLoading)} → ${esc(s.portDischarge)}</td>
      <td>${fmtDate(s.eta)}</td>
      <td>${badgeStatus(relStatus)}</td>
      <td><div class="actions"><button class="btn-icon" onclick="openReleaseModal('${s.id}')" title="Update Release">🚢</button></div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="text-muted" style="padding:16px;text-align:center">No shipments linked</td></tr>`);

  // Release status
  if (invShipments.length) {
    const rel = DB.releases.find(r=>r.shipmentId===invShipments[0].id);
    renderReleasePanel('inv-release', rel);
  }

  // Documents checklist
  renderDocChecklist('inv-docs', invDocs, invDispatches, inv.id);

  // Services
  setHTML('inv-services', invSvcs.length ? invSvcs.map(s=>`
    <tr>
      <td>${fmtDate(s.date)}</td>
      <td><span class="chip">${esc(s.type)}</span></td>
      <td>${esc(s.desc)}</td>
      <td class="amount debit">${fmtAmt(s.amount,s.currency)}</td>
      <td class="text-muted">${esc(s.vendor||'—')}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="text-muted" style="padding:12px;text-align:center">No service charges</td></tr>`);

  // Samples
  setHTML('inv-samples', invSamples.length ? invSamples.map(s=>`
    <div class="doc-item ${s.trackingRef?'present':''}">
      <span class="doc-icon">📦</span>
      <div class="doc-info">
        <div class="doc-name">Samples Sent — ${fmtDate(s.dateSent)}</div>
        <div class="doc-meta">${esc(s.courier||'—')} · ${s.trackingRef?`Tracking: ${esc(s.trackingRef)}`:'No tracking'} ${s.notes?'· '+esc(s.notes):''}</div>
      </div>
    </div>`).join('') : `<div class="text-muted" style="padding:12px">No sample records</div>`);

  // Follow-ups
  renderFollowupTimeline('inv-followups', invFups);

  // Wire buttons
  document.getElementById('inv-add-pay-btn').onclick  = ()=>openPayModal(id);
  document.getElementById('inv-add-ship-btn').onclick = ()=>openModal('modal-shipment', null, id);
  document.getElementById('inv-add-doc-btn').onclick  = ()=>openModal('modal-document', null, id);
  document.getElementById('inv-add-svc-btn').onclick  = ()=>openModal('modal-service', inv.buyerId, id);
  document.getElementById('inv-add-fu-btn').onclick   = ()=>openModal('modal-followup', inv.buyerId, id);
}

function renderReleasePanel(containerId, rel) {
  const status = computeReleaseStatus(rel);
  const telexDays = rel?.telexReleaseDate ? daysDiff(rel.telexReleaseDate) : null;
  const goodsDays = rel?.goodsReleaseDate ? daysDiff(rel.goodsReleaseDate) : null;
  setHTML(containerId, `
    <div class="release-panel">
      <div class="release-card ${rel?.telexReleaseDate?'rc-active':'rc-pending'}">
        <div class="rc-icon">📜</div>
        <div class="rc-label">Telex Release</div>
        <div class="rc-val">${rel?.telexReleaseDate?fmtDate(rel.telexReleaseDate):'Pending'}</div>
        ${telexDays!==null?`<div class="rc-days">${telexDays} days ago</div>`:''}
      </div>
      <div class="release-card ${rel?.goodsReleaseDate?'rc-active':'rc-pending'}">
        <div class="rc-icon">📦</div>
        <div class="rc-label">Goods Release</div>
        <div class="rc-val">${rel?.goodsReleaseDate?fmtDate(rel.goodsReleaseDate):'Pending'}</div>
        ${goodsDays!==null?`<div class="rc-days">${goodsDays} days ago</div>`:''}
      </div>
      <div class="release-card ${rel?.deliveryDate?'rc-active':'rc-pending'}">
        <div class="rc-icon">🚚</div>
        <div class="rc-label">Delivery</div>
        <div class="rc-val">${rel?.deliveryDate?fmtDate(rel.deliveryDate):'Pending'}</div>
        ${status?`<div class="rc-days">${badgeStatus(status)}</div>`:''}
      </div>
    </div>
  `);
}

function renderDocChecklist(containerId, docs, dispatches, invoiceId) {
  const required = ['Copy of Invoice','Bill of Lading','Packing List','AZO Certificate'];
  const allTypes = [...new Set([...required, ...docs.map(d=>d.type)])];
  const lastDispatch = dispatches.sort((a,b)=>b.date.localeCompare(a.date))[0];

  const rows = allTypes.map(type => {
    const doc = docs.find(d=>d.type===type);
    const isRequired = required.includes(type);
    const cls = doc ? 'present' : isRequired ? 'missing' : '';
    return `<div class="doc-item ${cls}">
      <span class="doc-icon">${doc?'✅':isRequired?'❌':'📎'}</span>
      <div class="doc-info">
        <div class="doc-name">${esc(type)}${isRequired?'<span style="color:var(--red);font-size:10px;margin-left:4px">Required</span>':''}</div>
        <div class="doc-meta">${doc?`Uploaded: ${fmtDate(doc.uploadDate)} · ${esc(doc.name)}`:'Not uploaded'}</div>
      </div>
      <div class="doc-status">${doc?`<span class="badge b-green">Uploaded</span>`:`<span class="badge b-red">Missing</span>`}</div>
    </div>`;
  });

  const dispatchInfo = lastDispatch ? `
    <div class="alert-strip info" style="margin-top:10px">
      <span class="alert-icon">📬</span>
      <div class="alert-body">
        <div class="alert-title">Documents Dispatched to Buyer</div>
        <div class="alert-sub">Date: ${fmtDate(lastDispatch.date)} · Mode: ${esc(lastDispatch.mode)} ${lastDispatch.trackingRef?'· Ref: '+esc(lastDispatch.trackingRef):''} · Sent: ${(lastDispatch.docsSent||[]).join(', ')}</div>
      </div>
    </div>` : `<div class="alert-strip warning" style="margin-top:10px"><span class="alert-icon">⚠️</span><div class="alert-body"><div class="alert-title">Documents Not Yet Dispatched to Buyer</div></div></div>`;

  setHTML(containerId, `<div class="doc-checklist">${rows.join('')}</div>${dispatchInfo}`);
}

// ─────────────────────────────────────────────────────────────
// INVOICES LIST
// ─────────────────────────────────────────────────────────────
function renderInvoices(q='', buyerFilter='', statusFilter='') {
  let list = DB.invoices.filter(i => {
    if (buyerFilter && i.buyerId !== buyerFilter) return false;
    if (q && !i.invoiceNo.toLowerCase().includes(q.toLowerCase()) && !i.product.toLowerCase().includes(q.toLowerCase())) return false;
    if (statusFilter && computeInvoiceStatus(i) !== statusFilter) return false;
    return true;
  });
  list.sort((a,b)=>b.date.localeCompare(a.date));

  const buyerOpts = DB.buyers.map(b=>`<option value="${b.id}">${esc(b.company)}</option>`).join('');
  setHTML('inv-buyer-filter', `<option value="">All Buyers</option>${buyerOpts}`);

  setHTML('inv-tbody', list.length ? list.map(i=>{
    const status = computeInvoiceStatus(i);
    const paid = invoiceTotalPaid(i.id);
    const outstanding = invoiceOutstanding(i);
    const pct = i.amount>0?Math.min(100,Math.round(paid/i.amount*100)):0;
    return `<tr>
      <td class="mono fw" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${i.id}')">${esc(i.invoiceNo)}</td>
      <td style="cursor:pointer" onclick="openBuyer('${i.buyerId}')">${esc(buyerName(i.buyerId))}</td>
      <td>${esc(i.product)}</td>
      <td>${fmtDate(i.date)}</td>
      <td>${fmtDate(i.dueDate)}</td>
      <td class="amount neutral">${fmtAmt(i.amount,i.currency)}</td>
      <td class="amount credit">${fmtAmt(paid,i.currency)}</td>
      <td class="amount debit" style="color:${outstanding>0?'var(--red)':'var(--green)'}">${fmtAmt(outstanding,i.currency)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="progress-bar" style="width:60px"><div class="progress-fill" style="width:${pct}%;background:${pct===100?'var(--green)':'var(--brand)'}"></div></div>
          <span style="font-size:11px;color:var(--ink4)">${pct}%</span>
        </div>
      </td>
      <td>${badgeStatus(status)}</td>
      <td><div class="actions">
        <button class="btn-icon" onclick="openInvoice('${i.id}')" title="View">👁</button>
        <button class="btn-icon" onclick="openPayModal('${i.id}')" title="Add Payment">💳</button>
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="11" class="text-muted" style="padding:30px;text-align:center">No invoices match your filters</td></tr>`);
}

// ─────────────────────────────────────────────────────────────
// SHIPMENTS
// ─────────────────────────────────────────────────────────────
function renderShipments() {
  const list = DB.shipments;
  setHTML('ship-tbody', list.length ? list.map(s=>{
    const rel = DB.releases.find(r=>r.shipmentId===s.id);
    const relStatus = computeReleaseStatus(rel);
    const telexDays = rel?.telexReleaseDate ? daysDiff(rel.telexReleaseDate) : null;
    return `<tr>
      <td class="mono fw">${esc(s.shipmentNo)}</td>
      <td style="cursor:pointer;color:var(--brand)" onclick="openBuyer('${s.buyerId}')">${esc(buyerName(s.buyerId))}</td>
      <td class="mono" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${s.invoiceId}')">${esc(invoiceNo(s.invoiceId))}</td>
      <td>${fmtDate(s.date)}</td>
      <td><span class="chip">${esc(s.mode)}</span></td>
      <td class="text-muted">${esc(s.containerNo||'—')}</td>
      <td class="text-muted">${esc(s.portLoading)}</td>
      <td class="text-muted">${esc(s.portDischarge)}</td>
      <td>${fmtDate(s.eta)}</td>
      <td>${badgeStatus(relStatus)}</td>
      <td>${rel?.telexReleaseDate?fmtDate(rel.telexReleaseDate):'<span class="badge b-amber">Pending</span>'}</td>
      <td>${telexDays!==null?telexDays+' days':'—'}</td>
      <td><div class="actions"><button class="btn-icon" onclick="openReleaseModal('${s.id}')" title="Update Release">🚢</button></div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="13" class="text-muted" style="padding:30px;text-align:center">No shipments</td></tr>`);
}

// ─────────────────────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────────────────────
function renderPayments(q='', buyerFilter='', statusFilter='') {
  let list = [...DB.payments].sort((a,b)=>b.date.localeCompare(a.date));
  if (buyerFilter) list = list.filter(p=>p.buyerId===buyerFilter);
  if (q) list = list.filter(p=>p.ref?.toLowerCase().includes(q.toLowerCase())||buyerName(p.buyerId).toLowerCase().includes(q.toLowerCase()));

  const buyerOpts = DB.buyers.map(b=>`<option value="${b.id}">${esc(b.company)}</option>`).join('');
  setHTML('pay-buyer-filter', `<option value="">All Buyers</option>${buyerOpts}`);

  setHTML('pay-tbody', list.length ? list.map(p=>`
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td style="cursor:pointer;color:var(--brand)" onclick="openBuyer('${p.buyerId}')">${esc(buyerName(p.buyerId))}</td>
      <td class="mono" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${p.invoiceId}')">${esc(invoiceNo(p.invoiceId))}</td>
      <td class="amount credit">${fmtAmt(p.amount,p.currency)}</td>
      <td>${esc(p.mode)}</td>
      <td class="mono text-muted">${esc(p.ref||'—')}</td>
      <td class="text-muted">${esc(p.placeReceived||'—')}</td>
      <td class="text-muted">${esc(p.notes||'—').slice(0,50)}</td>
      <td><div class="actions"><button class="btn-icon" style="color:var(--red)" onclick="deleteRecord('payments','${p.id}','pay-tbody',renderPayments)">🗑</button></div></td>
    </tr>`).join('')
    : `<tr><td colspan="9" class="text-muted" style="padding:30px;text-align:center">No payments</td></tr>`);
}

// ─────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────
function renderDocuments() {
  const list = DB.documents;
  setHTML('doc-tbody', list.length ? list.map(d=>`
    <tr>
      <td><span class="chip">${esc(d.type)}</span></td>
      <td>${esc(d.name)}</td>
      <td style="cursor:pointer;color:var(--brand)" onclick="openBuyer('${d.buyerId}')">${esc(buyerName(d.buyerId))}</td>
      <td class="mono" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${d.invoiceId||''}')">${d.invoiceId?esc(invoiceNo(d.invoiceId)):'—'}</td>
      <td>${fmtDate(d.uploadDate)}</td>
      <td>${d.fileRef?`<a href="#" class="badge b-blue" onclick="return false">📎 ${esc(d.fileRef)}</a>`:'—'}</td>
      <td>${esc(d.notes||'—')}</td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="text-muted" style="padding:30px;text-align:center">No documents</td></tr>`);
}

// ─────────────────────────────────────────────────────────────
// FOLLOW-UPS
// ─────────────────────────────────────────────────────────────
function renderFollowups() {
  const upcoming = DB.followups.filter(f=>f.status!=='Done').sort((a,b)=>a.nextDate?.localeCompare(b.nextDate||'')||0);
  const all = [...DB.followups].sort((a,b)=>b.date.localeCompare(a.date));

  setHTML('fu-upcoming', upcoming.length ? upcoming.map(f=>`
    <div class="alert-strip ${new Date(f.nextDate)<new Date()?'danger':'info'}">
      <span class="alert-icon">${f.method==='Call'?'📞':f.method==='Email'?'📧':'💬'}</span>
      <div class="alert-body">
        <div class="alert-title">${esc(buyerName(f.buyerId))} ${f.invoiceId?`· <span class="mono">${esc(invoiceNo(f.invoiceId))}</span>`:''}</div>
        <div class="alert-sub">Next: ${fmtDate(f.nextDate)} · ${esc(f.notes||'').slice(0,80)}</div>
      </div>
      ${badgeStatus(f.status)}
    </div>`).join('')
    : `<div class="alert-strip success"><span class="alert-icon">✅</span><div class="alert-body"><div class="alert-title">No pending follow-ups</div></div></div>`);

  setHTML('fu-tbody', all.map(f=>`
    <tr>
      <td>${fmtDate(f.date)}</td>
      <td style="cursor:pointer;color:var(--brand)" onclick="openBuyer('${f.buyerId}')">${esc(buyerName(f.buyerId))}</td>
      <td>${f.invoiceId?`<span class="mono" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${f.invoiceId}')">${esc(invoiceNo(f.invoiceId))}</span>`:'—'}</td>
      <td><span class="chip">${esc(f.method)}</span></td>
      <td class="text-muted">${esc(f.notes||'—').slice(0,80)}</td>
      <td>${fmtDate(f.nextDate)}</td>
      <td>${badgeStatus(f.status)}</td>
      <td><div class="actions"><button class="btn-icon" style="color:var(--red)" onclick="deleteRecord('followups','${f.id}','fu-tbody',renderFollowups)">🗑</button></div></td>
    </tr>`).join(''));
}

// ─────────────────────────────────────────────────────────────
// SERVICES
// ─────────────────────────────────────────────────────────────
function renderServices() {
  const list = [...DB.services].sort((a,b)=>b.date.localeCompare(a.date));
  const buyerOpts = DB.buyers.map(b=>`<option value="${b.id}">${esc(b.company)}</option>`).join('');
  setHTML('svc-buyer-filter', `<option value="">All Buyers</option>${buyerOpts}`);

  setHTML('svc-tbody', list.length ? list.map(s=>`
    <tr>
      <td>${fmtDate(s.date)}</td>
      <td style="cursor:pointer;color:var(--brand)" onclick="openBuyer('${s.buyerId}')">${esc(buyerName(s.buyerId))}</td>
      <td>${s.invoiceId?`<span class="mono" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${s.invoiceId}')">${esc(invoiceNo(s.invoiceId))}</span>`:'—'}</td>
      <td><span class="chip">${esc(s.type)}</span></td>
      <td>${esc(s.desc)}</td>
      <td class="amount debit">${fmtAmt(s.amount,s.currency)}</td>
      <td class="text-muted">${esc(s.vendor||'—')}</td>
      <td class="mono text-muted">${esc(s.ref||'—')}</td>
    </tr>`).join('')
    : `<tr><td colspan="8" class="text-muted" style="padding:30px;text-align:center">No service charges</td></tr>`);
}

// ─────────────────────────────────────────────────────────────
// AGING REPORT
// ─────────────────────────────────────────────────────────────
function renderAging() {
  const bucketLabels = ['0–30 Days','31–60 Days','61–90 Days','90+ Days'];
  const buckets = DB.buyers.map(b=>{
    const invs = DB.invoices.filter(i=>i.buyerId===b.id);
    const bkts = [0,0,0,0];
    let total = 0;
    invs.forEach(i=>{
      const bk = agingBucket(i);
      if (bk !== null) { bkts[bk] += invoiceOutstanding(i); total += invoiceOutstanding(i); }
    });
    return { b, bkts, total };
  }).filter(x=>x.total>0);

  const totals = [0,0,0,0];
  buckets.forEach(r=>r.bkts.forEach((v,i)=>totals[i]+=v));
  const grandTotal = totals.reduce((s,v)=>s+v,0);

  setHTML('aging-tbody', buckets.length ? [
    ...buckets.map(({b,bkts,total})=>`
      <tr>
        <td style="cursor:pointer;color:var(--brand)" onclick="openBuyer('${b.id}')">${esc(b.company)}</td>
        <td class="aging-bucket-0">${bkts[0]>0?fmtAmt(bkts[0],'USD'):'—'}</td>
        <td class="aging-bucket-1">${bkts[1]>0?fmtAmt(bkts[1],'USD'):'—'}</td>
        <td class="aging-bucket-2">${bkts[2]>0?fmtAmt(bkts[2],'USD'):'—'}</td>
        <td class="aging-bucket-3">${bkts[3]>0?fmtAmt(bkts[3],'USD'):'—'}</td>
        <td style="font-weight:600">${fmtAmt(total,'USD')}</td>
      </tr>`),
    `<tr>
      <td style="font-weight:700;background:var(--ink);color:#fff">TOTAL</td>
      <td class="aging-bucket-0" style="font-weight:700">${fmtAmt(totals[0],'USD')}</td>
      <td class="aging-bucket-1" style="font-weight:700">${fmtAmt(totals[1],'USD')}</td>
      <td class="aging-bucket-2" style="font-weight:700">${fmtAmt(totals[2],'USD')}</td>
      <td class="aging-bucket-3" style="font-weight:700">${fmtAmt(totals[3],'USD')}</td>
      <td style="font-weight:700">${fmtAmt(grandTotal,'USD')}</td>
    </tr>`
  ].join('')
  : `<tr><td colspan="6" class="text-muted" style="padding:30px;text-align:center">No overdue balances ✓</td></tr>`);

  // Per-invoice aging
  const invAging = DB.invoices.map(i=>{
    const bk = agingBucket(i);
    if (bk===null) return null;
    return { i, bk, outstanding: invoiceOutstanding(i) };
  }).filter(Boolean).sort((a,b)=>b.bk-a.bk||b.outstanding-a.outstanding);

  setHTML('aging-inv-tbody', invAging.length ? invAging.map(({i,bk,outstanding})=>`
    <tr>
      <td class="mono fw" style="cursor:pointer;color:var(--brand)" onclick="openInvoice('${i.id}')">${esc(i.invoiceNo)}</td>
      <td style="cursor:pointer" onclick="openBuyer('${i.buyerId}')">${esc(buyerName(i.buyerId))}</td>
      <td>${fmtDate(i.dueDate)}</td>
      <td>${daysDiff(i.dueDate)} days</td>
      <td class="amount debit">${fmtAmt(outstanding,i.currency)}</td>
      <td><span class="badge ${['b-green','b-amber','b-orange','b-red'][bk]}">${bucketLabels[bk]}</span></td>
    </tr>`).join('')
    : `<tr><td colspan="6" class="text-muted" style="padding:20px;text-align:center">No overdue invoices</td></tr>`);
}

// ─────────────────────────────────────────────────────────────
// BUYER STATEMENT (opens in overlay)
// ─────────────────────────────────────────────────────────────
function renderStatement(buyerId) {
  const b = DB.buyers.find(x=>x.id===buyerId);
  if (!b) return;
  const t = buyerTotals(buyerId);
  const invs = DB.invoices.filter(i=>i.buyerId===buyerId);
  const svcs = DB.services.filter(s=>s.buyerId===buyerId);
  const pays = DB.payments.filter(p=>p.buyerId===buyerId);

  const bucketLabels = ['0–30 Days','31–60 Days','61–90 Days','90+ Days'];
  const bkts = [0,0,0,0];
  invs.forEach(i=>{ const bk=agingBucket(i); if(bk!==null) bkts[bk]+=invoiceOutstanding(i); });

  const html = `
    <div id="statement-print">
    <div class="statement-header">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:12px;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Account Statement</div>
          <h2>${esc(b.company)}</h2>
          <div class="sh-meta">🌍 ${esc(b.country)} · 📧 ${esc(b.email)} · Terms: ${esc(b.payTerms)}</div>
          <div class="sh-meta" style="margin-top:4px">Generated: ${fmtDate(today())} · Currency: ${esc(b.currency)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:28px;font-weight:700;color:${t.totalOutstanding>0?'#FCA5A5':'#6EE7B7'}">${fmtAmt(t.totalOutstanding,b.currency)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.55)">Total Outstanding</div>
        </div>
      </div>
    </div>
    <div class="statement-totals">
      <div class="st-cell"><div class="stc-label">Total Invoiced</div><div class="stc-val" style="color:var(--brand)">${fmtAmt(t.totalInvoiced,b.currency)}</div></div>
      <div class="st-cell"><div class="stc-label">Total Paid</div><div class="stc-val" style="color:var(--green)">${fmtAmt(t.totalPaid,b.currency)}</div></div>
      <div class="st-cell"><div class="stc-label">Outstanding</div><div class="stc-val" style="color:${t.totalOutstanding>0?'var(--red)':'var(--green)'}">${fmtAmt(t.totalOutstanding,b.currency)}</div></div>
      <div class="st-cell"><div class="stc-label">Services Total</div><div class="stc-val" style="color:var(--amber)">${fmtAmt(t.totalServices,b.currency)}</div></div>
    </div>
    <div style="padding:20px 24px">
      <h3 style="font-size:14px;font-weight:600;margin-bottom:12px;padding-bottom:8px;border-bottom:var(--border)">Invoice Summary</h3>
      <div class="tbl-wrap">
        <table class="data-table">
          <thead><tr><th>Invoice No</th><th>Product</th><th>Date</th><th>Due Date</th><th>Amount</th><th>Paid</th><th>Outstanding</th><th>Status</th></tr></thead>
          <tbody>
            ${invs.map(i=>{
              const st=computeInvoiceStatus(i);
              const pd=invoiceTotalPaid(i.id);
              const ou=invoiceOutstanding(i);
              return `<tr>
                <td class="mono fw">${esc(i.invoiceNo)}</td>
                <td>${esc(i.product)}</td>
                <td>${fmtDate(i.date)}</td>
                <td>${fmtDate(i.dueDate)}</td>
                <td class="amount neutral">${fmtAmt(i.amount,i.currency)}</td>
                <td class="amount credit">${fmtAmt(pd,i.currency)}</td>
                <td class="amount debit">${fmtAmt(ou,i.currency)}</td>
                <td>${badgeStatus(st)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${svcs.length?`
      <h3 style="font-size:14px;font-weight:600;margin:20px 0 12px;padding-bottom:8px;border-bottom:var(--border)">Service Charges</h3>
      <div class="tbl-wrap">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Invoice</th><th>Amount</th><th>Vendor</th></tr></thead>
          <tbody>
            ${svcs.map(s=>`<tr>
              <td>${fmtDate(s.date)}</td>
              <td><span class="chip">${esc(s.type)}</span></td>
              <td>${esc(s.desc)}</td>
              <td class="mono">${s.invoiceId?esc(invoiceNo(s.invoiceId)):'—'}</td>
              <td class="amount debit">${fmtAmt(s.amount,s.currency)}</td>
              <td class="text-muted">${esc(s.vendor||'—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`:''}
      <h3 style="font-size:14px;font-weight:600;margin:20px 0 12px;padding-bottom:8px;border-bottom:var(--border)">Payment History</h3>
      <div class="tbl-wrap">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Invoice</th><th>Amount</th><th>Mode</th><th>Reference</th><th>Place Received</th></tr></thead>
          <tbody>
            ${pays.map(p=>`<tr>
              <td>${fmtDate(p.date)}</td>
              <td class="mono">${esc(invoiceNo(p.invoiceId))}</td>
              <td class="amount credit">${fmtAmt(p.amount,p.currency)}</td>
              <td>${esc(p.mode)}</td>
              <td class="mono text-muted">${esc(p.ref||'—')}</td>
              <td class="text-muted">${esc(p.placeReceived||'—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${bkts.some(v=>v>0)?`
      <h3 style="font-size:14px;font-weight:600;margin:20px 0 12px;padding-bottom:8px;border-bottom:var(--border)">Aging Summary</h3>
      <table class="aging-table" style="border-radius:var(--rl);overflow:hidden">
        <thead><tr><th>0–30 Days</th><th>31–60 Days</th><th>61–90 Days</th><th>90+ Days</th><th>Total</th></tr></thead>
        <tbody><tr>
          <td class="aging-bucket-0">${fmtAmt(bkts[0],b.currency)}</td>
          <td class="aging-bucket-1">${fmtAmt(bkts[1],b.currency)}</td>
          <td class="aging-bucket-2">${fmtAmt(bkts[2],b.currency)}</td>
          <td class="aging-bucket-3">${fmtAmt(bkts[3],b.currency)}</td>
          <td style="font-weight:700">${fmtAmt(bkts.reduce((s,v)=>s+v,0),b.currency)}</td>
        </tr></tbody>
      </table>`:''}
    </div>
    </div>
  `;

  setHTML('statement-content', html);
  document.getElementById('modal-statement').classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────────────
function openModal(type, buyerId=null, invoiceId=null) {
  closePreviousModals();
  populateSelects();
  const modals = {
    'modal-buyer':    ()=>{ setEditMode('buyer',null); },
    'modal-invoice':  ()=>{ setEditMode('invoice',null); if(buyerId){ setVal('inv-buyer',buyerId); } },
    'modal-shipment': ()=>{ populateShipmentModal(); if(invoiceId){ setVal('ship-invoice',invoiceId); } },
    'modal-document': ()=>{ if(invoiceId){ setVal('doc-invoice',invoiceId); const inv=DB.invoices.find(i=>i.id===invoiceId); if(inv){setVal('doc-buyer',inv.buyerId);setVal('doc-shipment','');} } },
    'modal-service':  ()=>{ if(buyerId) setVal('svc-buyer',buyerId); if(invoiceId) setVal('svc-invoice',invoiceId); },
    'modal-followup': ()=>{ if(buyerId) setVal('fu-buyer',buyerId); if(invoiceId) setVal('fu-invoice',invoiceId); setVal('fu-date',today()); },
    'modal-dispatch': ()=>{ if(invoiceId) setVal('dispatch-invoice',invoiceId); },
    'modal-release':  ()=>{},
  };
  if (modals[type]) modals[type]();
  const el = document.getElementById(type);
  if (el) el.classList.remove('hidden');
}

function closePreviousModals() {
  document.querySelectorAll('.modal-overlay:not(#modal-statement)').forEach(m=>m.classList.add('hidden'));
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

document.querySelectorAll('.modal-overlay').forEach(o=>{
  o.addEventListener('click', e=>{ if(e.target===o) o.classList.add('hidden'); });
});

function openPayModal(invoiceId=null, buyerId=null) {
  closePreviousModals();
  populateSelects();
  if (invoiceId) {
    setVal('pay-invoice', invoiceId);
    const inv = DB.invoices.find(i=>i.id===invoiceId);
    if (inv) { setVal('pay-buyer', inv.buyerId); setVal('pay-currency', inv.currency); }
  } else if (buyerId) {
    setVal('pay-buyer', buyerId);
  }
  setVal('pay-date', today());
  document.getElementById('modal-payment')?.classList.remove('hidden');
}

function openReleaseModal(shipmentId) {
  closePreviousModals();
  const rel = DB.releases.find(r=>r.shipmentId===shipmentId);
  setVal('rel-shipment-id', shipmentId);
  setVal('rel-telex', rel?.telexReleaseDate||'');
  setVal('rel-goods', rel?.goodsReleaseDate||'');
  setVal('rel-delivery', rel?.deliveryDate||'');
  setVal('rel-notes', rel?.notes||'');
  document.getElementById('modal-release')?.classList.remove('hidden');
}

function populateSelects() {
  const buyerOpts = `<option value="">Select buyer…</option>` + DB.buyers.map(b=>`<option value="${b.id}">${esc(b.company)}</option>`).join('');
  const invOpts   = `<option value="">Select invoice…</option>` + DB.invoices.map(i=>`<option value="${i.id}">${esc(i.invoiceNo)} — ${esc(buyerName(i.buyerId))}</option>`).join('');
  const shipOpts  = `<option value="">Select shipment…</option>` + DB.shipments.map(s=>`<option value="${s.id}">${esc(s.shipmentNo)}</option>`).join('');

  ['inv-buyer','fu-buyer','svc-buyer','doc-buyer','pay-buyer','dispatch-buyer'].forEach(id=>{ const e=document.getElementById(id); if(e) e.innerHTML=buyerOpts; });
  ['pay-invoice','fu-invoice','svc-invoice','doc-invoice','dispatch-invoice'].forEach(id=>{ const e=document.getElementById(id); if(e) e.innerHTML=invOpts; });
  ['doc-shipment','ship-invoice'].forEach(id=>{ const e=document.getElementById(id); if(e) e.innerHTML=(id==='ship-invoice'?invOpts:shipOpts); });
}

function populateShipmentModal() {
  const invOpts = `<option value="">Select invoice…</option>` + DB.invoices.map(i=>`<option value="${i.id}">${esc(i.invoiceNo)}</option>`).join('');
  const el = document.getElementById('ship-invoice'); if(el) el.innerHTML=invOpts;
}

function setEditMode(type, id) {}

const getVal = id => { const e=document.getElementById(id); return e?e.value.trim():''; };
const setVal = (id,v) => { const e=document.getElementById(id); if(e) e.value=v; };

// ─────────────────────────────────────────────────────────────
// SAVE ACTIONS
// ─────────────────────────────────────────────────────────────
function saveBuyer() {
  const company = getVal('b-company'); if(!company){ toast('Company name required','⚠️'); return; }
  DB.buyers.push({ id:uid(), company, contact:getVal('b-contact'), email:getVal('b-email'), phone:getVal('b-phone'), whatsapp:getVal('b-whatsapp'), country:getVal('b-country'), address:getVal('b-address'), payTerms:getVal('b-payterms'), currency:getVal('b-currency')||'USD', notes:getVal('b-notes') });
  saveDB(); closeModal('modal-buyer'); renderBuyers(); renderDashboard(); toast('Buyer added ✓','🏢');
}

function saveInvoice() {
  const buyerId=getVal('inv-buyer'), invNo=getVal('inv-no'), amount=+getVal('inv-amount');
  if(!buyerId||!invNo||!amount){ toast('Buyer, invoice no, and amount required','⚠️'); return; }
  if(amount<=0){ toast('Amount must be positive','⚠️'); return; }
  DB.invoices.push({ id:uid(), buyerId, invoiceNo:invNo, product:getVal('inv-product'), description:getVal('inv-desc'), date:getVal('inv-date')||today(), dueDate:getVal('inv-due'), amount, currency:getVal('inv-currency')||'USD', payTerms:getVal('inv-payterms'), status:'Issued', notes:getVal('inv-notes') });
  saveDB(); closeModal('modal-invoice'); renderInvoices(); toast('Invoice created ✓','📄');
}

function savePayment() {
  const buyerId=getVal('pay-buyer'), invoiceId=getVal('pay-invoice'), amount=+getVal('pay-amount');
  if(!buyerId||!invoiceId||!amount){ toast('Buyer, invoice and amount required','⚠️'); return; }
  if(amount<=0){ toast('Amount must be positive','⚠️'); return; }
  const inv = DB.invoices.find(i=>i.id===invoiceId);
  const exRate = +getVal('pay-exrate')||1;
  const amtInInvCur = getVal('pay-currency')===inv?.currency ? amount : amount*exRate;
  DB.payments.push({ id:uid(), buyerId, invoiceId, date:getVal('pay-date')||today(), amount, amountInInvCurrency:amtInInvCur, currency:getVal('pay-currency')||'USD', exchangeRate:exRate, placeReceived:getVal('pay-place'), mode:getVal('pay-mode')||'Bank Transfer', ref:getVal('pay-ref'), notes:getVal('pay-notes'), fileRef:null });
  saveDB(); closeModal('modal-payment');
  // Refresh current view
  if (currentPage==='invoice-detail') renderInvoiceDetail(currentInvoiceId);
  else if (currentPage==='buyer-detail') renderBuyerDetail(currentBuyerId);
  else renderPayments();
  renderDashboard();
  toast('Payment recorded ✓','💳');
}

function saveShipment() {
  const buyerId=getVal('ship-buyer'), invoiceId=getVal('ship-invoice');
  if(!buyerId||!invoiceId){ toast('Buyer and invoice required','⚠️'); return; }
  const shipNo = getVal('ship-no') || `SHP-${new Date().getFullYear()}-${String(DB.shipments.length+1).padStart(3,'0')}`;
  DB.shipments.push({ id:uid(), buyerId, invoiceId, shipmentNo:shipNo, date:getVal('ship-date')||today(), mode:getVal('ship-mode')||'Sea', vessel:getVal('ship-vessel'), voyageNo:getVal('ship-voyage'), containerNo:getVal('ship-container'), portLoading:getVal('ship-pol'), portDischarge:getVal('ship-pod'), etd:getVal('ship-etd'), eta:getVal('ship-eta'), notes:getVal('ship-notes') });
  saveDB(); closeModal('modal-shipment'); renderShipments(); toast('Shipment added ✓','🚢');
}

function saveDocument() {
  const buyerId=getVal('doc-buyer'), type=getVal('doc-type'), name=getVal('doc-name');
  if(!buyerId||!type||!name){ toast('Buyer, type and name required','⚠️'); return; }
  DB.documents.push({ id:uid(), buyerId, invoiceId:getVal('doc-invoice')||null, shipmentId:getVal('doc-shipment')||null, type, name, uploadDate:getVal('doc-date')||today(), fileRef:name, notes:getVal('doc-notes') });
  saveDB(); closeModal('modal-document');
  if(currentPage==='invoice-detail') renderInvoiceDetail(currentInvoiceId);
  else renderDocuments();
  toast('Document saved ✓','📎');
}

function saveService() {
  const buyerId=getVal('svc-buyer'), type=getVal('svc-type'), amount=+getVal('svc-amount');
  if(!buyerId||!type||!amount){ toast('Buyer, type and amount required','⚠️'); return; }
  DB.services.push({ id:uid(), buyerId, invoiceId:getVal('svc-invoice')||null, type, desc:getVal('svc-desc'), amount, currency:getVal('svc-currency')||'USD', date:getVal('svc-date')||today(), vendor:getVal('svc-vendor'), ref:getVal('svc-ref'), notes:getVal('svc-notes'), fileRef:null });
  saveDB(); closeModal('modal-service');
  if(currentPage==='buyer-detail') renderBuyerDetail(currentBuyerId);
  else if(currentPage==='invoice-detail') renderInvoiceDetail(currentInvoiceId);
  else renderServices();
  renderDashboard();
  toast('Service charge added ✓','🧾');
}

function saveFollowup() {
  const buyerId=getVal('fu-buyer');
  if(!buyerId){ toast('Buyer required','⚠️'); return; }
  DB.followups.push({ id:uid(), buyerId, invoiceId:getVal('fu-invoice')||null, date:getVal('fu-date')||today(), method:getVal('fu-method')||'Email', notes:getVal('fu-notes'), nextDate:getVal('fu-next'), status:getVal('fu-status')||'Pending' });
  saveDB(); closeModal('modal-followup');
  if(currentPage==='buyer-detail') renderBuyerDetail(currentBuyerId);
  else if(currentPage==='invoice-detail') renderInvoiceDetail(currentInvoiceId);
  else renderFollowups();
  toast('Follow-up logged ✓','📌');
}

function saveDispatch() {
  const buyerId=getVal('dispatch-buyer'), invoiceId=getVal('dispatch-invoice');
  if(!buyerId||!invoiceId){ toast('Buyer and invoice required','⚠️'); return; }
  const docsSent = Array.from(document.querySelectorAll('input[name="dispatch-docs"]:checked')).map(c=>c.value);
  DB.dispatches.push({ id:uid(), buyerId, invoiceId, shipmentId:null, date:getVal('dispatch-date')||today(), mode:getVal('dispatch-mode'), trackingRef:getVal('dispatch-ref'), notes:getVal('dispatch-notes'), docsSent });
  saveDB(); closeModal('modal-dispatch');
  if(currentPage==='invoice-detail') renderInvoiceDetail(currentInvoiceId);
  toast('Dispatch recorded ✓','📬');
}

function saveRelease() {
  const shipmentId = getVal('rel-shipment-id');
  const existing = DB.releases.find(r=>r.shipmentId===shipmentId);
  const data = { shipmentId, telexReleaseDate:getVal('rel-telex')||null, goodsReleaseDate:getVal('rel-goods')||null, deliveryDate:getVal('rel-delivery')||null, notes:getVal('rel-notes') };
  if (existing) { Object.assign(existing, data); }
  else { DB.releases.push({ id:uid(), ...data }); }
  saveDB(); closeModal('modal-release');
  if(currentPage==='invoice-detail') renderInvoiceDetail(currentInvoiceId);
  else renderShipments();
  toast('Release status updated ✓','🚢');
}

function deleteRecord(collection, id, tbodyId, refreshFn) {
  if (!confirm('Delete this record?')) return;
  DB[collection] = DB[collection].filter(x=>x.id!==id);
  saveDB(); if(refreshFn) refreshFn(); toast('Deleted','🗑');
}

// ─────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────
function toast(msg, icon='✅') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className='toast';
  t.innerHTML=`<span>${icon}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(()=>{ t.classList.add('removing'); setTimeout(()=>t.remove(),200); },2800);
}

// ─────────────────────────────────────────────────────────────
// GLOBAL SEARCH
// ─────────────────────────────────────────────────────────────
function globalSearch(q) {
  if (!q) return;
  const lq = q.toLowerCase();
  // Try buyer
  const buyer = DB.buyers.find(b=>b.company.toLowerCase().includes(lq)||b.contact.toLowerCase().includes(lq));
  if (buyer) { openBuyer(buyer.id); return; }
  // Try invoice
  const inv = DB.invoices.find(i=>i.invoiceNo.toLowerCase().includes(lq)||i.product.toLowerCase().includes(lq));
  if (inv) { openInvoice(inv.id); return; }
  toast(`No results for "${q}"`, '🔍');
}

// ─────────────────────────────────────────────────────────────
// PRINT STATEMENT
// ─────────────────────────────────────────────────────────────
function printStatement() { window.print(); }

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
loadDB();
// Wire nav items
document.querySelectorAll('.nav-item[data-page]').forEach(btn=>{
  btn.addEventListener('click',()=>nav(btn.dataset.page));
});
// Mobile menu
document.getElementById('mobile-menu-btn')?.addEventListener('click',()=>{
  document.querySelector('.sidebar')?.classList.toggle('open');
});
// Global search
document.getElementById('global-search')?.addEventListener('keydown',e=>{
  if(e.key==='Enter') globalSearch(e.target.value);
});
renderDashboard();
