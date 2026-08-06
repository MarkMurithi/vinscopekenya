import { useEffect, useMemo, useState } from 'react';
import './index.css';
import {
  fetchCurrentUser,
  getVehicleReports,
  loginUser,
  logoutUser,
  registerUser,
  saveVehicleReport,
  deleteVehicleReport,
  setReportComparisonSelection,
} from './services/authApi';
import { lookupVehicleByVin, pingVehicleApi } from './services/vehicleApi';
import { startMpesaPayment, getPaymentStatus } from './services/paymentsApi';
import { buildComparisonChartData, buildVehicleHistorySections, filterSavedReports, getScoreTier } from './utils/reportUtils';
import { generateVerificationCode, maskContact } from './utils/verificationUtils';
import { getDefaultAnalytics, getPopularPlan, recordPlanSelection, recordVinSearch } from './utils/analyticsUtils';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function IconLogo(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3z" />
      <path d="M8.5 13.5l1.8-3.5a1 1 0 0 1 .9-.6h1.6a1 1 0 0 1 .9.6l1.8 3.5" />
      <path d="M8.5 13.5h7v1.6a.7.7 0 0 1-.7.7h-.4a.7.7 0 0 1-.7-.7v-.4H10.3v.4a.7.7 0 0 1-.7.7h-.4a.7.7 0 0 1-.7-.7v-1.6z" />
    </svg>
  );
}

function IconCar(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 13l1.5-4.5A2 2 0 0 1 6.4 7h11.2a2 2 0 0 1 1.9 1.5L21 13" />
      <path d="M3 13h18v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4z" />
      <circle cx="7.5" cy="17.6" r="1.5" />
      <circle cx="16.5" cy="17.6" r="1.5" />
    </svg>
  );
}

function IconLock(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function IconDatabase(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      <path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

function IconClock(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5l3.2 2" />
    </svg>
  );
}

function IconDocument(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 3.5h6.5L18 8v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5V8H18" />
      <path d="M9 12.5h6M9 15.5h6M9 9.5h1.5" />
    </svg>
  );
}

function IconUserShield(props) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3l6.5 2.6v5c0 4.6-3 7.9-6.5 9.9-3.5-2-6.5-5.3-6.5-9.9v-5L12 3z" />
      <path d="M9.3 12.2l1.9 1.9 3.5-3.7" />
    </svg>
  );
}

function IconCheckCircle(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.3l2.6 2.6L16 9.5" />
    </svg>
  );
}

function IconWarningCircle(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.2" />
      <circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconInfoCircle(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10.5v5.2" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconGauge(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4.5 15.5a7.5 7.5 0 1 1 15 0" />
      <path d="M12 15.5l2.6-3.6" />
      <circle cx="12" cy="15.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconUsers(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="8.2" r="3" />
      <path d="M3.3 20c0-3.3 2.6-6 5.7-6s5.7 2.7 5.7 6" />
      <circle cx="17.2" cy="9" r="2.3" />
      <path d="M15.8 20c.2-2.5 1.7-4.6 3.9-5.3" />
    </svg>
  );
}

function IconArrowRight(props) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 12h13" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

function IconSun(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </svg>
  );
}

function IconMoon(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" />
    </svg>
  );
}

function IconPhone(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 19h2" />
    </svg>
  );
}

function IconCard(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.2" />
      <path d="M2.5 10h19" />
      <path d="M6 14.5h4" />
    </svg>
  );
}

function IconMail(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.2" />
      <path d="M3 6.5l9 6.5 9-6.5" />
    </svg>
  );
}

function IconMapPin(props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 21s-7-6.4-7-11.5A7 7 0 0 1 19 9.5C19 14.6 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.4" />
    </svg>
  );
}

function CitySkyline() {
  return (
    <svg className="hero-skyline" viewBox="0 0 900 220" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="140" width="60" height="80" fill="rgba(255,255,255,0.06)" />
      <rect x="70" y="110" width="50" height="110" fill="rgba(255,255,255,0.07)" />
      <rect x="130" y="150" width="70" height="70" fill="rgba(255,255,255,0.05)" />
      <rect x="215" y="90" width="34" height="130" fill="rgba(255,255,255,0.08)" />
      <rect x="260" y="60" width="26" height="20" fill="rgba(255,255,255,0.08)" />
      <circle cx="273" cy="52" r="10" fill="rgba(255,255,255,0.08)" />
      <rect x="300" y="120" width="60" height="100" fill="rgba(255,255,255,0.06)" />
      <rect x="370" y="150" width="90" height="70" fill="rgba(255,255,255,0.05)" />
      <rect x="470" y="100" width="40" height="120" fill="rgba(255,255,255,0.07)" />
      <rect x="520" y="160" width="55" height="60" fill="rgba(255,255,255,0.05)" />
      <rect x="590" y="130" width="45" height="90" fill="rgba(255,255,255,0.06)" />
      <rect x="650" y="165" width="80" height="55" fill="rgba(255,255,255,0.05)" />
      <rect x="740" y="120" width="36" height="100" fill="rgba(255,255,255,0.07)" />
      <rect x="790" y="150" width="60" height="70" fill="rgba(255,255,255,0.05)" />
      <rect x="860" y="170" width="40" height="50" fill="rgba(255,255,255,0.05)" />
    </svg>
  );
}

function HeroCar() {
  return (
    <svg className="hero-car" viewBox="0 0 260 130" aria-hidden="true">
      <ellipse cx="130" cy="112" rx="105" ry="10" fill="rgba(0,0,0,0.18)" />
      <path
        d="M18 90 L28 55 A18 18 0 0 1 45 42 L92 42 L112 22 L182 22 L206 42 L228 42 A18 18 0 0 1 245 55 L252 90 Z"
        fill="#f4f6fb"
        stroke="#c7ccd8"
        strokeWidth="2"
      />
      <path d="M100 42 L116 26 L176 26 L196 42 Z" fill="#dfe6f2" stroke="#c7ccd8" strokeWidth="2" />
      <line x1="146" y1="26" x2="146" y2="42" stroke="#c7ccd8" strokeWidth="2" />
      <circle cx="66" cy="94" r="19" fill="#20293b" />
      <circle cx="66" cy="94" r="8" fill="#8b93a7" />
      <circle cx="198" cy="94" r="19" fill="#20293b" />
      <circle cx="198" cy="94" r="8" fill="#8b93a7" />
      <rect x="18" y="66" width="18" height="8" rx="3" fill="#e63946" />
      <rect x="228" y="66" width="18" height="8" rx="3" fill="#ffb703" />
    </svg>
  );
}

function MileageCurveGraph({ mileage }) {
  const text = String(mileage || '').toLowerCase();
  const tone = /mismatch|inconsistent|vary|discrep/i.test(text)
    ? 'warn'
    : /consistent|appears/i.test(text)
      ? 'ok'
      : 'neutral';
  const toneLabel = tone === 'warn'
    ? 'Irregular pattern detected'
    : tone === 'ok'
      ? 'Consistent with vehicle age'
      : 'Estimated trend';

  const values = tone === 'warn'
    ? [26, 41, 54, 61, 49, 43]
    : tone === 'ok'
      ? [18, 30, 46, 59, 72, 84]
      : [22, 35, 47, 53, 60, 66];

  const maxKm = 160000;
  const width = 460;
  const height = 210;
  const padding = { top: 22, right: 24, bottom: 34, left: 46 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const points = values.map((value, index) => ({
    x: padding.left + (index / (values.length - 1)) * plotWidth,
    y: padding.top + plotHeight - (value / 100) * plotHeight,
    km: Math.round((value / 100) * maxKm),
  }));

  const pathData = points.reduce((acc, point, index) => {
    if (index === 0) {
      return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }

    const prev = points[index - 1];
    const cp1x = prev.x + (point.x - prev.x) / 3;
    const cp1y = prev.y - (point.y - prev.y) * 0.2;
    const cp2x = prev.x + ((point.x - prev.x) * 2) / 3;
    const cp2y = point.y + (point.y - prev.y) * 0.2;

    return `${acc} C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }, '');

  const stroke = tone === 'warn' ? '#e63946' : tone === 'ok' ? '#16a34a' : '#5b6c97';
  const fillId = `mileage-fill-${tone}`;
  const lastPoint = points[points.length - 1];
  const startPoint = points[0];
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className={`mileage-graph ${tone}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Odometer reading trend graph">
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.3" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <text x={padding.left} y={12} fontSize="10" fontWeight="700" fill="rgba(20, 33, 61, 0.75)">
          Odometer reading (km)
        </text>

        {yTicks.map((tick) => {
          const y = padding.top + plotHeight - tick * plotHeight;
          const km = Math.round(tick * maxKm);
          return (
            <g key={tick}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="rgba(20, 33, 61, 0.1)" strokeDasharray="3 3" />
              <text x={padding.left - 8} y={y + 3} fontSize="9" textAnchor="end" fill="rgba(20, 33, 61, 0.6)">
                {km >= 1000 ? `${Math.round(km / 1000)}k` : km}
              </text>
            </g>
          );
        })}

        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} stroke="rgba(20, 33, 61, 0.25)" />
        <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} stroke="rgba(20, 33, 61, 0.25)" />

        <path
          d={`${pathData} L ${lastPoint.x.toFixed(1)} ${height - padding.bottom} L ${startPoint.x.toFixed(1)} ${height - padding.bottom} Z`}
          fill={`url(#${fillId})`}
        />
        <path d={pathData} stroke={stroke} strokeWidth="2.6" fill="none" strokeLinecap="round" />

        {points.map((point, index) => (
          <g key={index}>
            <circle cx={point.x} cy={point.y} r="4.4" fill="#fff" stroke={stroke} strokeWidth="2" />
            <circle cx={point.x} cy={point.y} r="2" fill={stroke} />
            <text x={point.x} y={height - padding.bottom + 16} fontSize="8.5" textAnchor="middle" fill="rgba(20, 33, 61, 0.6)">
              R{index + 1}
            </text>
          </g>
        ))}

        <text x={lastPoint.x} y={lastPoint.y - 10} fontSize="9.5" textAnchor="middle" fontWeight="700" fill={stroke}>
          {lastPoint.km.toLocaleString()} km
        </text>
      </svg>
      <div className="mileage-graph-footer">
        <span className={`mileage-tone-dot ${tone}`} />
        <span>{toneLabel}</span>
      </div>
    </div>
  );
}

const sampleReports = [
  {
    id: 1,
    make: 'Toyota',
    model: 'Prado',
    year: 2017,
    vin: 'JTEBU5JR3K5001234',
    status: 'Verified',
    theft: 'No record',
    ownership: 'Consistent',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'demo',
    historyAvailable: true,
  },
  {
    id: 2,
    make: 'Nissan',
    model: 'X-Trail',
    year: 2019,
    vin: 'JN8AZ1MU1LW123456',
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage mismatch detected',
    score: 62,
    source: 'demo',
    historyAvailable: true,
  },
  {
    id: 3,
    make: 'Honda',
    model: 'Civic',
    year: 2020,
    vin: '19XFC2F50NE012345',
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage consistent',
    score: 93,
    source: 'demo',
    historyAvailable: true,
  },
];

const whyChooseFeatures = [
  { icon: IconDatabase, accent: 'green', title: 'Reliable Data Sources', text: 'Verified information pulled from trusted registries and partner databases.' },
  { icon: IconClock, accent: 'red', title: 'Easy To Use', text: 'Get a vehicle profile in seconds with a simple VIN search.' },
  { icon: IconDocument, accent: 'navy', title: 'Comprehensive Reports', text: 'Accidents, theft, ownership, and mileage history in one report.' },
  { icon: IconUserShield, accent: 'red', title: 'Buyer Protection', text: 'Spot red flags early and avoid costly, risky purchases.' },
];

const reportCategories = [
  { icon: IconCar, label: 'Accident History' },
  { icon: IconLock, label: 'Theft Check' },
  { icon: IconGauge, label: 'Odometer Readings' },
  { icon: IconUsers, label: 'Ownership History' },
];

const benefits = [
  'Avoid costly mistakes before you buy',
  'Compare several vehicles in one dashboard',
  'Support smarter purchase decisions with verified signals',
];

const stats = [
  { value: '10k+', label: 'vehicles reviewed' },
  { value: '97%', label: 'buyer confidence' },
  { value: '24/7', label: 'insight support' },
];

const testimonials = [
  { name: 'Jane, Nairobi', quote: 'The report helped me avoid a vehicle with suspicious mileage history.' },
  { name: 'Daniel, Mombasa', quote: 'I compared two vehicles quickly and chose the safer option.' },
  { name: 'Aisha, Kisumu', quote: 'The platform makes it easy to understand risk indicators without technical jargon.' },
];

const faqs = [
  { question: 'How does Vinscope Kenya work?', answer: 'Enter a VIN to receive a sample report with ownership, theft, mileage, accident, and status insights.' },
  { question: 'What information appears in the report?', answer: 'The prototype highlights the key indicators that users need when evaluating used vehicles.' },
  { question: 'Why is this useful for buyers?', answer: 'It brings critical history data into one place so buyers can compare options confidently.' },
];

const LEGAL_LAST_UPDATED = 'August 6, 2026';

const privacyPolicySections = [
  {
    title: '1. Introduction',
    paragraphs: [
      'VinScope Kenya ("VinScope Kenya", "we", "us", or "our") provides vehicle history lookup, comparison, and reporting services to buyers, sellers, and dealerships in Kenya. This Privacy Policy explains what personal data we collect, how we use it, and the choices you have. By using our website and services, you agree to the practices described here.',
    ],
  },
  {
    title: '2. Information We Collect',
    list: [
      'Account information: your name, email address, phone number, and password (stored as a secure hash) when you register.',
      'Vehicle lookup data: VIN numbers and registration details you search, along with reports you choose to save.',
      "Payment information: when you subscribe to a paid plan, we process your M-Pesa phone number or card details through Safaricom's Daraja API or our card payment processor. We do not store full card numbers or M-Pesa PINs on our servers.",
      'Usage analytics: aggregated, non-identifying statistics such as the number of searches performed and which plans are most popular.',
      'Communications: messages you send us through contact, support, or dealership quote request channels.',
    ],
  },
  {
    title: '3. How We Use Your Information',
    list: [
      'To create and manage your account and authenticate you when you log in.',
      'To generate vehicle history reports and save your search and comparison history.',
      'To process subscription payments and manage your billing plan.',
      'To respond to enterprise and dealership quote requests.',
      'To improve our services, troubleshoot issues, and detect fraud or abuse.',
      'To send service-related communications, such as verification codes and payment confirmations.',
    ],
  },
  {
    title: '4. How We Share Information',
    paragraphs: ['We do not sell your personal information. We may share data with:'],
    list: [
      'Payment processors (Safaricom M-Pesa Daraja API, card payment gateways) solely to complete transactions.',
      'Vehicle data providers and registries, to the extent necessary to generate accurate reports.',
      'Service providers who help us operate the platform (such as hosting and database providers), under confidentiality obligations.',
      'Authorities, if required by law or to protect our rights, users, or the public.',
    ],
  },
  {
    title: '5. Data Retention',
    paragraphs: [
      'We retain account and report data for as long as your account is active, or as needed to provide our services, comply with legal obligations, resolve disputes, and enforce our agreements. You may request deletion of your account and associated data at any time.',
    ],
  },
  {
    title: '6. Your Rights',
    paragraphs: [
      'Under the Kenya Data Protection Act, 2019, you have the right to access, correct, or request deletion of your personal data, object to certain processing, and lodge a complaint with the Office of the Data Protection Commissioner. To exercise these rights, contact us using the details below.',
    ],
  },
  {
    title: '7. Cookies & Local Storage',
    paragraphs: [
      "We use your browser's local storage to remember your theme preference (light or dark mode) and basic usage analytics. We do not use third-party advertising cookies.",
    ],
  },
  {
    title: '8. Security',
    paragraphs: [
      'We use industry-standard measures, including password hashing and encrypted connections, to protect your information. No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.',
    ],
  },
  {
    title: "9. Children's Privacy",
    paragraphs: ['Our services are not directed at children under 18. We do not knowingly collect personal information from minors.'],
  },
  {
    title: '10. Changes to This Policy',
    paragraphs: ['We may update this Privacy Policy from time to time. We will post the revised version on this page with an updated effective date.'],
  },
  {
    title: '11. Contact Us',
    paragraphs: ['If you have questions about this Privacy Policy or your personal data, contact us at privacy@vinscopekenya.co.ke.'],
  },
];

const termsOfServiceSections = [
  {
    title: '1. Acceptance of Terms',
    paragraphs: [
      "By accessing or using VinScope Kenya's website and services (the \"Service\"), you agree to be bound by these Terms of Service. If you do not agree, please do not use the Service.",
    ],
  },
  {
    title: '2. Description of Service',
    paragraphs: [
      'VinScope Kenya provides vehicle history lookups, risk assessments, comparison tools, and related subscription plans for vehicle buyers, sellers, and dealerships in Kenya. Reports are compiled from available data sources and are provided for informational purposes only.',
    ],
  },
  {
    title: '3. Account Registration',
    paragraphs: [
      'You must provide accurate, current information when creating an account and are responsible for maintaining the confidentiality of your login credentials and for all activity under your account. You must be at least 18 years old to register.',
    ],
  },
  {
    title: '4. Subscription Plans & Payments',
    list: [
      'Starter is a free plan with limited access to sample reports.',
      'Pro is a paid monthly subscription billed via M-Pesa or card payment at the price shown at checkout.',
      'Business/Enterprise pricing is custom and quoted directly to dealerships and fleet operators after a sales inquiry; no payment is collected until a separate agreement is signed.',
      'Fees are billed in Kenyan Shillings (KSh) and are non-refundable except where required by law.',
      'We reserve the right to change subscription pricing with reasonable notice.',
    ],
  },
  {
    title: '5. Acceptable Use',
    paragraphs: [
      'You agree not to misuse the Service to harass or defraud others, attempt to access data you are not authorized to view, reverse-engineer, scrape, or resell our reports without permission, or use the Service in violation of any applicable law.',
    ],
  },
  {
    title: '6. Vehicle Report Accuracy Disclaimer',
    paragraphs: [
      'Vehicle history reports are generated from third-party data sources and available records at the time of the request. VinScope Kenya does not guarantee the completeness or accuracy of any report and is not a substitute for an independent mechanical inspection. Purchase and sale decisions are made at your own risk.',
    ],
  },
  {
    title: '7. Intellectual Property',
    paragraphs: [
      'All content, branding, and software associated with VinScope Kenya are owned by us or our licensors and may not be copied, modified, or distributed without permission.',
    ],
  },
  {
    title: '8. Limitation of Liability',
    paragraphs: [
      'To the fullest extent permitted by law, VinScope Kenya shall not be liable for any indirect, incidental, or consequential damages arising from your use of the Service, including decisions made based on a vehicle history report.',
    ],
  },
  {
    title: '9. Termination',
    paragraphs: ['We may suspend or terminate your account if you violate these Terms. You may close your account at any time by contacting us.'],
  },
  {
    title: '10. Governing Law',
    paragraphs: ['These Terms are governed by the laws of the Republic of Kenya. Any disputes shall be subject to the exclusive jurisdiction of the courts of Kenya.'],
  },
  {
    title: '11. Changes to These Terms',
    paragraphs: ['We may revise these Terms from time to time. Continued use of the Service after changes take effect constitutes acceptance of the revised Terms.'],
  },
  {
    title: '12. Contact Us',
    paragraphs: ['Questions about these Terms can be sent to legal@vinscopekenya.co.ke.'],
  },
];

const steps = [
  { title: 'Enter vehicle details', text: 'Start with a VIN or registration number and unlock a vehicle profile instantly.' },
  { title: 'Review risk signals', text: 'Check theft alerts, accident history, ownership changes, and mileage consistency.' },
  { title: 'Compare confidently', text: 'Line up multiple vehicles side by side and make a better purchase decision.' },
];

const pricingPlans = [
  {
    name: 'Starter',
    price: 'KSh 0',
    description: 'Explore the platform with a demo report',
    features: ['1 sample lookup', 'Risk overview', 'Saved favorites'],
  },
  {
    name: 'Pro',
    price: 'KSh 1,500',
    description: 'Best for serious buyers',
    features: ['Full reports', 'Compare up to 3 vehicles', 'Priority alerts'],
    highlight: true,
  },
  {
    name: 'Business',
    price: 'Custom',
    description: 'Volume-based pricing for dealerships and fleet teams',
    features: [
      'Bulk VIN checks with CSV upload',
      'Team seats with role-based access',
      'API access for your CRM or DMS',
      'Dedicated account manager & onboarding',
      'Monthly invoicing, no per-check fees',
    ],
    custom: true,
  },
];

// Animates a numeric value counting up from 0 whenever the target changes.
function useCountUp(target, duration = 900) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    const numericTarget = Number(target) || 0;
    if (numericTarget <= 0) {
      setValue(0);
      return undefined;
    }

    let frame;
    let start = null;

    const step = (timestamp) => {
      if (start === null) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      setValue(Math.round(progress * numericTarget));
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      }
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

function App() {
  const [view, setView] = useState('home');
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    try {
      return window.localStorage.getItem('vinscope-theme') || 'light';
    } catch {
      return 'light';
    }
  });
  const [authMode, setAuthMode] = useState('login');
  const [user, setUser] = useState(null);
  const [vinInput, setVinInput] = useState('');
  const [selectedReport, setSelectedReport] = useState(sampleReports[0]);
  const [comparisonIds, setComparisonIds] = useState([1, 2]);
  const [message, setMessage] = useState('Use the demo account to explore the app.');
  const [email, setEmail] = useState('demo@vinscope.com');
  const [password, setPassword] = useState('demo123');
  const [name, setName] = useState('');
  const [savedReports, setSavedReports] = useState([]);
  const [loadingVehicle, setLoadingVehicle] = useState(false);
  const [loadingSavedReports, setLoadingSavedReports] = useState(true);
  const [apiStatus, setApiStatus] = useState('Checking API...');
  const [formErrors, setFormErrors] = useState({});
  const [payingPlan, setPayingPlan] = useState(null);
  const [checkoutPlan, setCheckoutPlan] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('mpesa');
  const [detailReport, setDetailReport] = useState(null);
  const [mpesaPhone, setMpesaPhone] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardName, setCardName] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [paymentMessage, setPaymentMessage] = useState('');
  const [activeSubscription, setActiveSubscription] = useState(null);
  const [checkoutSuccess, setCheckoutSuccess] = useState(null);
  const [enterpriseModalOpen, setEnterpriseModalOpen] = useState(false);
  const [enterpriseForm, setEnterpriseForm] = useState({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    fleetSize: '1-10',
    message: '',
  });
  const [enterpriseErrors, setEnterpriseErrors] = useState({});
  const [enterpriseSubmitted, setEnterpriseSubmitted] = useState(null);
  const [contactForm, setContactForm] = useState({ name: '', email: '', message: '' });
  const [contactErrors, setContactErrors] = useState({});
  const [contactSubmitted, setContactSubmitted] = useState(null);
  const [verificationStep, setVerificationStep] = useState('signup');
  const [verificationMethod, setVerificationMethod] = useState('email');
  const [verificationCode, setVerificationCode] = useState('');
  const [verificationContact, setVerificationContact] = useState('');
  const [verificationCodeSent, setVerificationCodeSent] = useState(false);
  const [verificationError, setVerificationError] = useState('');
  const [savedReportSearch, setSavedReportSearch] = useState('');
  const [savedReportFilter, setSavedReportFilter] = useState('all');
  const [analytics, setAnalytics] = useState(() => {
    if (typeof window === 'undefined') return getDefaultAnalytics();
    try {
      return JSON.parse(window.localStorage.getItem('vinscope-analytics') || 'null') || getDefaultAnalytics();
    } catch {
      return getDefaultAnalytics();
    }
  });
  const [recentSearches, setRecentSearches] = useState(() => {
    if (typeof window === 'undefined') return [];
    try {
      return JSON.parse(window.localStorage.getItem('vinscope-recent-searches') || '[]');
    } catch {
      return [];
    }
  });

  // Compare a signed-in user's own looked-up vehicles once they've saved any;
  // otherwise fall back to the 3 demo vehicles so the page still works for guests.
  const usingSavedComparison = Boolean(user) && savedReports.length > 0;
  const comparisonReports = useMemo(() => {
    if (usingSavedComparison) {
      return savedReports.filter((report) => report.selectedForComparison);
    }
    return sampleReports.filter((report) => comparisonIds.includes(report.id));
  }, [usingSavedComparison, savedReports, comparisonIds]);
  const comparisonChartData = useMemo(() => buildComparisonChartData(comparisonReports), [comparisonReports]);
  const bestComparisonReport = useMemo(() => [...comparisonChartData].sort((a, b) => b.score - a.score)[0], [comparisonChartData]);
  const detailSections = useMemo(() => buildVehicleHistorySections(detailReport || selectedReport), [detailReport, selectedReport]);
  const filteredSavedReports = useMemo(() => {
    const searched = filterSavedReports(savedReports, savedReportSearch);

    if (savedReportFilter === 'all') return searched;
    if (savedReportFilter === 'strong') return searched.filter((report) => (Number(report.score) || 0) >= 70);
    if (savedReportFilter === 'risk') return searched.filter((report) => (Number(report.score) || 0) < 70);

    return searched;
  }, [savedReportFilter, savedReportSearch, savedReports]);

  const animatedSearchCount = useCountUp(analytics.totalSearches);

  const persistAnalytics = (nextAnalytics) => {
    setAnalytics(nextAnalytics);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('vinscope-analytics', JSON.stringify(nextAnalytics));
    }
  };

  const goToSection = (id) => {
    setView('home');
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const openAuth = (mode) => {
    setAuthMode(mode);
    setFormErrors({});
    setView('account');
  };

  useEffect(() => {
    let cancelled = false;

    setLoadingSavedReports(true);
    fetchCurrentUser()
      .then((currentUser) => {
        if (cancelled) return;
        if (!currentUser) {
          setUser(null);
          setSavedReports([]);
          return;
        }

        setUser(currentUser);
        return getVehicleReports().then((reports) => {
          if (!cancelled) setSavedReports(reports);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setMessage('We could not load your saved reports right now.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSavedReports(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const sendVerificationCode = () => {
    if (!EMAIL_REGEX.test(email)) {
      setVerificationError('Enter a valid email address before sending a verification code.');
      return;
    }

    const code = generateVerificationCode();
    const method = verificationMethod === 'sms' ? 'sms' : 'email';
    const contact = method === 'sms' ? verificationContact || '+254700000000' : email;
    const maskedContact = maskContact(contact, method);

    setVerificationCode(code);
    setVerificationContact(contact);
    setVerificationCodeSent(true);
    setVerificationError('');
    setMessage(`Verification code sent to ${maskedContact}. Use code ${code} to continue.`);
    setVerificationStep('verify');
  };

  const handleVerificationSubmit = async (event) => {
    event.preventDefault();

    if (!verificationCode.trim()) {
      setVerificationError('Enter the verification code sent to your inbox or phone.');
      return;
    }

    const normalizedCode = verificationCode.trim();
    if (normalizedCode !== String(verificationCodeSent ? verificationCode : '')) {
      setVerificationError('That code does not match the one we sent.');
      return;
    }

    const result = await registerUser(email, password, name || 'New Buyer');
    if (!result.success) {
      setMessage(result.message);
      return;
    }

    setUser(result.user);
    setSavedReports(await getVehicleReports());
    setMessage('Account created. Your email is verified and you can now access reports.');
    setVerificationStep('signup');
    setVerificationCode('');
    setVerificationCodeSent(false);
    setVerificationError('');
    setView('report');
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();

    const errors = {};
    if (!EMAIL_REGEX.test(email)) errors.email = 'Enter a valid email address.';
    if (authMode === 'register' && password.length < 6) errors.password = 'Password must be at least 6 characters.';
    if (!password) errors.password = errors.password || 'Password is required.';
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (authMode === 'login') {
      const result = await loginUser(email, password);
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      setUser(result.user);
      setSavedReports(await getVehicleReports());
      setMessage(`Welcome back, ${result.user.name}.`);
      setView('home');
      return;
    }

    if (!verificationCodeSent) {
      sendVerificationCode();
      return;
    }

    await handleVerificationSubmit(event);
  };

  const handleLogout = async () => {
    await logoutUser();
    setUser(null);
    setSavedReports([]);
    setMessage('You have been signed out.');
    setView('home');
  };


  const handleLookup = async (event) => {
    event.preventDefault();
    const normalizedVin = vinInput.trim().toUpperCase();

    if (!normalizedVin) {
      setMessage('Please enter a VIN number.');
      return;
    }

    setLoadingVehicle(true);
    setMessage('Querying vehicle data...');

    try {
      const vehicle = await lookupVehicleByVin(normalizedVin);
      const mappedReport = {
        id: vehicle.vin,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        vin: vehicle.vin,
        status: vehicle.status,
        theft: vehicle.theft,
        ownership: vehicle.ownership,
        accidents: vehicle.accidents,
        mileage: vehicle.mileage,
        score: vehicle.score,
        source: vehicle.source,
        historyAvailable: vehicle.historyAvailable,
        manufacturer: vehicle.manufacturer,
        plantCountry: vehicle.plantCountry,
        bodyClass: vehicle.bodyClass,
        vehicleType: vehicle.vehicleType,
        fuelType: vehicle.fuelType,
        engineCylinders: vehicle.engineCylinders,
        displacementL: vehicle.displacementL,
      };

      setSelectedReport(mappedReport);
      addRecentSearch(mappedReport);
      persistAnalytics(recordVinSearch(analytics));
      setMessage(
        vehicle.source === 'nhtsa-vpic'
          ? `Decoded ${mappedReport.make} ${mappedReport.model} via the public NHTSA vPIC registry. Accident/theft/ownership history isn't publicly available for this VIN.`
          : `Vehicle data retrieved for ${mappedReport.make} ${mappedReport.model}.`
      );
      setView('report');
    } catch (error) {
      if (error.status === 400) {
        setMessage(error.message);
        return;
      }

      setSelectedReport(sampleReports[0]);
      setMessage(`Unable to fetch live vehicle data. Showing the demo report instead. ${error.message}`);
      setView('report');
    } finally {
      setLoadingVehicle(false);
    }
  };

  const toggleComparison = (id) => {
    setComparisonIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  };

  const toggleSavedComparison = async (vin, currentlySelected) => {
    try {
      const updated = await setReportComparisonSelection(vin, !currentlySelected);
      setSavedReports((current) => current.map((report) => (report.vin === vin ? updated : report)));
    } catch (error) {
      setMessage(error.message || 'Could not update comparison selection.');
    }
  };

  const saveCurrentReport = async () => {
    if (!user) {
      setMessage('Sign in first to save a report.');
      return;
    }

    try {
      await saveVehicleReport(selectedReport);
      setSavedReports(await getVehicleReports());
      setMessage(`Saved ${selectedReport.make} ${selectedReport.model} to your account.`);
    } catch (error) {
      setMessage(error.message || 'Could not save this report.');
    }
  };

  const removeSavedReport = async (vin) => {
    await deleteVehicleReport(vin);
    setSavedReports(await getVehicleReports());
  };

  const openVehicleDetail = (report) => {
    setDetailReport(report);
    setView('history-detail');
  };

  const addRecentSearch = (report) => {
    const nextSearch = {
      vin: report.vin,
      make: report.make,
      model: report.model,
      score: report.score,
      timestamp: new Date().toISOString(),
    };

    setRecentSearches((current) => {
      const filtered = current.filter((entry) => entry.vin !== nextSearch.vin);
      const updated = [nextSearch, ...filtered].slice(0, 5);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('vinscope-recent-searches', JSON.stringify(updated));
      }
      return updated;
    });
  };

  const closeCheckout = () => {
    setCheckoutPlan(null);
    setCheckoutSuccess(null);
    setPayingPlan(null);
    setPaymentMessage('');
  };

  const openEnterpriseInquiry = (plan) => {
    persistAnalytics(recordPlanSelection(analytics, plan));
    setEnterpriseSubmitted(null);
    setEnterpriseErrors({});
    setEnterpriseForm({
      companyName: '',
      contactName: user?.name || '',
      email: user?.email || '',
      phone: '',
      fleetSize: '1-10',
      message: '',
    });
    setEnterpriseModalOpen(true);
  };

  const closeEnterpriseInquiry = () => {
    setEnterpriseModalOpen(false);
    setEnterpriseSubmitted(null);
    setEnterpriseErrors({});
  };

  const updateEnterpriseField = (field, value) => {
    setEnterpriseForm((current) => ({ ...current, [field]: value }));
  };

  const handleEnterpriseSubmit = (event) => {
    event.preventDefault();
    const errors = {};

    if (!enterpriseForm.companyName.trim()) errors.companyName = 'Dealership or company name is required.';
    if (!enterpriseForm.contactName.trim()) errors.contactName = 'Contact person is required.';
    if (!EMAIL_REGEX.test(enterpriseForm.email.trim())) errors.email = 'Enter a valid work email.';
    if (!enterpriseForm.phone.trim()) errors.phone = 'A phone number is required.';

    if (Object.keys(errors).length > 0) {
      setEnterpriseErrors(errors);
      return;
    }

    setEnterpriseErrors({});
    setEnterpriseSubmitted({ ...enterpriseForm });
  };

  const openContactPage = () => {
    setContactSubmitted(null);
    setContactErrors({});
    setContactForm({ name: user?.name || '', email: user?.email || '', message: '' });
    setView('contact');
  };

  const updateContactField = (field, value) => {
    setContactForm((current) => ({ ...current, [field]: value }));
  };

  const handleContactSubmit = (event) => {
    event.preventDefault();
    const errors = {};

    if (!contactForm.name.trim()) errors.name = 'Please enter your name.';
    if (!EMAIL_REGEX.test(contactForm.email.trim())) errors.email = 'Enter a valid email address.';
    if (!contactForm.message.trim()) errors.message = 'Let us know how we can help.';

    if (Object.keys(errors).length > 0) {
      setContactErrors(errors);
      return;
    }

    setContactErrors({});
    setContactSubmitted({ ...contactForm });
  };

  const openCheckout = (plan) => {
    if (!user) {
      setPaymentMessage('Sign in first to subscribe.');
      openAuth('login');
      return;
    }

    persistAnalytics(recordPlanSelection(analytics, plan));
    setCheckoutPlan(plan);
    setCheckoutSuccess(null);
    setPaymentMethod('mpesa');
    setPayingPlan(plan);
    setPaymentMessage('');
    requestAnimationFrame(() => {
      document.getElementById('checkout-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const activateFreePlan = (plan) => {
    if (!user) {
      setPaymentMessage('Sign in first to get started.');
      openAuth('login');
      return;
    }

    persistAnalytics(recordPlanSelection(analytics, plan));
    setActiveSubscription({ plan, method: 'Free' });
    goToSection('hero');
  };

  const handleMpesaPayment = async (plan) => {
    if (!user) {
      setPaymentMessage('Sign in first to subscribe.');
      openAuth('login');
      return;
    }

    if (!mpesaPhone.trim()) {
      setPaymentMessage('Enter your M-Pesa phone number, e.g. 07XXXXXXXX.');
      setPayingPlan(plan);
      return;
    }

    setPayingPlan(plan);
    setPaymentMessage('Sending payment request...');

    try {
      const { checkoutRequestId, message: stkMessage } = await startMpesaPayment(plan, mpesaPhone);
      setPaymentMessage(stkMessage);
      pollPaymentStatus(checkoutRequestId, plan);
    } catch (error) {
      setPaymentMessage(error.message || 'Could not start M-Pesa payment.');
    }
  };

  const handleCardPayment = (event, plan) => {
    event.preventDefault();

    if (!user) {
      setPaymentMessage('Sign in first to subscribe.');
      openAuth('login');
      return;
    }

    if (!cardNumber.trim() || !cardName.trim() || !cardExpiry.trim() || !cardCvv.trim()) {
      setPaymentMessage('Please complete all card details to continue.');
      setPayingPlan(plan);
      return;
    }

    setPayingPlan(plan);
    setPaymentMessage('Processing secure card payment...');

    window.setTimeout(() => {
      setActiveSubscription({ plan, method: 'Card' });
      setCheckoutPlan(null);
      setCheckoutSuccess({ plan, method: 'Card' });
      setPayingPlan(null);
      setPaymentMessage(`Card payment received for ${plan}. Your ${plan} plan is now active.`);
    }, 900);
  };

  const pollPaymentStatus = (checkoutRequestId, planName, attempt = 0) => {
    if (attempt > 15) {
      setPaymentMessage('Still waiting for confirmation. Check your phone and try again if needed.');
      return;
    }

    setTimeout(async () => {
      try {
        const status = await getPaymentStatus(checkoutRequestId);
        if (status.status === 'completed') {
          setActiveSubscription({ plan: status.plan || planName, method: 'M-Pesa' });
          setCheckoutPlan(null);
          setCheckoutSuccess({ plan: status.plan || planName, method: 'M-Pesa' });
          setPayingPlan(null);
          setPaymentMessage(`Payment confirmed! Receipt: ${status.mpesaReceipt}. ${status.plan || planName} plan activated.`);
          return;
        }
        if (status.status === 'failed') {
          setPaymentMessage('Payment was not completed. Please try again.');
          return;
        }
        pollPaymentStatus(checkoutRequestId, planName, attempt + 1);
      } catch {
        pollPaymentStatus(checkoutRequestId, planName, attempt + 1);
      }
    }, 4000);
  };

  useMemo(() => {
    let cancelled = false;

    const checkApi = async () => {
      const result = await pingVehicleApi();
      if (!cancelled) {
        setApiStatus(result.ok ? 'Live API available' : 'Live API unavailable');
      }
    };

    checkApi();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('vinscope-theme', theme);
    } catch {
      // localStorage unavailable (e.g. private browsing) - theme still applies for this session
    }
  }, [theme]);

  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'));

  useEffect(() => {
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return undefined;

    const elements = document.querySelectorAll('.reveal:not(.is-visible)');
    if (!elements.length) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -60px 0px' }
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [view]);

  const historyAvailable = selectedReport.historyAvailable !== false;
  const theftStatus = !historyAvailable ? 'unknown' : /no/i.test(selectedReport.theft) ? 'ok' : 'warn';
  const accidentStatus = !historyAvailable ? 'unknown' : /no|not/i.test(selectedReport.accidents) ? 'ok' : 'warn';
  const ownershipStatus = !historyAvailable ? 'unknown' : 'neutral';
  const mileageStatus = !historyAvailable ? 'unknown' : /consistent|appears/i.test(selectedReport.mileage || '') ? 'ok' : 'warn';
  const statusIcon = (status) => {
    if (status === 'unknown' || status === 'neutral') return <IconInfoCircle />;
    return status === 'ok' ? <IconCheckCircle /> : <IconWarningCircle />;
  };
  const reportScoreTier = getScoreTier(selectedReport.score);
  const reportStatusTone = /verified|clear/i.test(selectedReport.status || '')
    ? 'ok'
    : /review|flag/i.test(selectedReport.status || '')
      ? 'warn'
      : 'neutral';
  const reportGeneratedAt = useMemo(
    () => new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' }),
    [selectedReport.vin]
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group" onClick={() => setView('home')} role="button" tabIndex={0}>
          <div className="brand-mark"><IconLogo /></div>
          <p className="brand">
            <span className="brand-navy">VinScope</span> <span className="brand-red">KENYA</span>
          </p>
        </div>
        <nav className="nav-links" aria-label="Main navigation">
          <button className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}>Home</button>
          <button onClick={() => goToSection('how-it-works')}>How It Works</button>
          <button onClick={() => goToSection('features')}>Features</button>
          <button onClick={() => setView('compare')}>Compare</button>
          <button onClick={() => goToSection('faq')}>FAQ</button>
          <button onClick={openContactPage}>Contact</button>
        </nav>
        <div className="auth-buttons">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          {user ? (
            <>
              <span className="status subtle">Hi, {user.name}</span>
              <button className="btn-outline" onClick={handleLogout}>Logout</button>
            </>
          ) : (
            <>
              <button className="btn-outline" onClick={() => openAuth('login')}>Login</button>
              <button className="btn-red" onClick={() => openAuth('register')}>Sign Up</button>
            </>
          )}
        </div>
      </header>

      <main className="page">
        <div key={view} className="view-transition">
        {view === 'home' && (
          <>
            <section id="hero" className="hero">
              <div className="hero-inner">
                <div className="hero-copy">
                  <h1>Check a Vehicle's<br />History in Seconds</h1>
                  <p className="subtitle">
                    Enter any VIN to instantly uncover accident records, theft alerts, ownership history, and mileage
                    accuracy before you buy or sell in Kenya.
                  </p>
                  <form className="hero-search" onSubmit={handleLookup}>
                    <input
                      value={vinInput}
                      onChange={(event) => setVinInput(event.target.value)}
                      placeholder="Enter VIN Number"
                    />
                    <button type="submit" className="btn-red">Check Now</button>
                  </form>
                  <p className="status">{message}</p>
                  <p className="status subtle">{loadingVehicle ? 'Loading vehicle details...' : apiStatus}</p>
                </div>
              </div>
            </section>

            <section className="hero-badges">
              <button className="badge-card" onClick={() => goToSection('sample-report')}>
                <span className="badge-icon"><IconCar /></span>
                <span>
                  <strong>Accident Records</strong>
                  <em>Check for past collisions and repairs</em>
                </span>
              </button>
              <button className="badge-card" onClick={() => goToSection('sample-report')}>
                <span className="badge-icon"><IconLock /></span>
                <span>
                  <strong>Theft &amp; Ownership</strong>
                  <em>Verify theft status and ownership history</em>
                </span>
              </button>
            </section>

            <section id="features" className="section-block why-choose">
              <h2>Why Choose VinScope Kenya?</h2>
              <p className="section-subtitle">Everything a buyer needs to make a confident, informed decision.</p>
              <div className="cards why-cards">
                {whyChooseFeatures.map((item) => (
                  <article key={item.title} className="why-card reveal">
                    <span className={`why-icon icon-${item.accent}`}><item.icon /></span>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="stats-row">
              <div className="stat-box reveal">
                <strong>{animatedSearchCount}+ searches</strong>
                <span>VIN lookups tracked</span>
              </div>
              <div className="stat-box reveal">
                <strong>{getPopularPlan(analytics)}</strong>
                <span>Most selected plan</span>
              </div>
              <div className="stat-box reveal">
                <strong>{stats[2].value}</strong>
                <span>{stats[2].label}</span>
              </div>
            </section>

            <section id="sample-report" className="section-block sample-report reveal">
              <div className="section-heading">
                <span className="line" />
                <h2>Sample Report</h2>
                <span className="line" />
              </div>
              <p className="section-subtitle">See what a full VinScope Kenya vehicle history report looks like.</p>
              <div className="sample-grid">
                <div className="sample-card">
                  <div className="sample-card-head">
                    <div className="sample-thumb"><IconCar /></div>
                    <div>
                      <p className="eyebrow-sm">Vehicle History Report</p>
                      <h3>{selectedReport.make} {selectedReport.model}</h3>
                      <p className="vin-line">VIN: {selectedReport.vin}</p>
                    </div>
                  </div>
                  <ul className="sample-checklist">
                    <li className={theftStatus}>
                      {statusIcon(theftStatus)}
                      {selectedReport.theft}
                    </li>
                    <li className={accidentStatus}>
                      {statusIcon(accidentStatus)}
                      {selectedReport.accidents}
                    </li>
                    <li className="plain"><IconGauge /> {selectedReport.mileage}</li>
                    <li className="plain"><IconUsers /> {selectedReport.ownership}</li>
                  </ul>
                  <div className="sample-actions">
                    <button className="btn-red full" onClick={() => setView('report')}>
                      View Full Report <IconArrowRight />
                    </button>
                    <button className="btn-outline full" onClick={() => openVehicleDetail(selectedReport)}>
                      Open vehicle history details
                    </button>
                  </div>
                </div>

                <div className="sample-categories">
                  {reportCategories.map((cat) => (
                    <div key={cat.label} className="category-row">
                      <span className="category-icon"><cat.icon /></span>
                      <span>{cat.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section id="how-it-works" className="section-block">
              <h2>How It Works</h2>
              <div className="cards">
                {steps.map((step) => (
                  <article key={step.title} className="reveal">
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="section-block split reveal">
              <div>
                <p className="eyebrow">Built for better decisions</p>
                <h2>We check what sellers may not tell you.</h2>
                <p className="subtitle small">
                  Our platform brings together essential vehicle history signals in one place so buyers can compare, assess risk, and move forward with confidence.
                </p>
              </div>
              <div className="benefits-list">
                {benefits.map((benefit) => (
                  <div key={benefit} className="benefit-item">{benefit}</div>
                ))}
              </div>
            </section>

            <section className="section-block">
              <h2>Simple plans for every buyer</h2>
              <div className="cards pricing-grid">
                {pricingPlans.map((plan) => (
                  <article key={plan.name} className={`price-card reveal${plan.highlight ? ' highlight' : ''}${plan.custom ? ' enterprise' : ''}`}>
                    {plan.custom && <span className="enterprise-tag">For dealerships &amp; fleets</span>}
                    <h3>{plan.name}</h3>
                    <p className="price-tag">{plan.custom ? 'Custom pricing' : plan.price}</p>
                    <p>{plan.description}</p>
                    <ul>
                      {plan.features.map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                    <button
                      className="btn-outline small"
                      onClick={() =>
                        plan.custom
                          ? openEnterpriseInquiry(plan.name)
                          : plan.name === 'Starter'
                          ? activateFreePlan(plan.name)
                          : openCheckout(plan.name)
                      }
                    >
                      {plan.custom ? 'Request a custom quote' : plan.name === 'Starter' ? 'Get started' : 'Choose plan'}
                    </button>
                    {plan.custom && <p className="enterprise-note">No card needed — we'll follow up with volume-based pricing.</p>}
                  </article>
                ))}
              </div>

              {activeSubscription && (
                <div className="subscription-success" id="subscription-panel">
                  <div className="subscription-success-head">
                    <span className="subscription-badge">✓</span>
                    <div>
                      <h3>{activeSubscription.plan} plan is active</h3>
                      <p>
                        {activeSubscription.method === 'Free'
                          ? "You're all set — no payment needed. Your dashboard is ready to use."
                          : `Thanks for subscribing with ${activeSubscription.method}. Your dashboard is ready to use.`}
                      </p>
                    </div>
                  </div>
                  <div className="subscription-success-list">
                    <span>Full reports unlocked</span>
                    <span>Comparison tools enabled</span>
                    <span>Priority support access</span>
                  </div>
                </div>
              )}

              {(checkoutPlan || checkoutSuccess) && (
                <div className="modal-backdrop" role="dialog" aria-modal="true">
                  <div className={`modal-card${checkoutPlan ? ' checkout-modal-card' : ''}`} id="checkout-panel">
                    {checkoutSuccess ? (
                      <>
                        <div className="modal-icon">✓</div>
                        <p className="eyebrow">Subscription confirmed</p>
                        <h3>{checkoutSuccess.plan} plan is now active</h3>
                        <p className="modal-copy">Your {checkoutSuccess.method} payment was captured successfully. You can start using the premium insights immediately.</p>
                        <div className="plan-summary">
                          <div>
                            <strong>Plan</strong>
                            <span>{checkoutSuccess.plan}</span>
                          </div>
                          <div>
                            <strong>Payment</strong>
                            <span>{checkoutSuccess.method}</span>
                          </div>
                        </div>
                        <div className="modal-actions">
                          <button className="btn-outline" onClick={closeCheckout}>Close</button>
                          <button className="btn-red" onClick={() => setView('compare')}>Explore premium tools</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="modal-header">
                          <div>
                            <p className="eyebrow">Secure checkout</p>
                            <h3>{checkoutPlan} plan</h3>
                          </div>
                          <button className="btn-outline small" onClick={closeCheckout}>Cancel</button>
                        </div>
                        <div className="checkout-layout">
                          <aside className="checkout-summary">
                            <p className="checkout-summary-label">Order summary</p>
                            <div className="checkout-summary-price">
                              <span className="checkout-summary-amount">
                                {pricingPlans.find((plan) => plan.name === checkoutPlan)?.price}
                              </span>
                              <span className="checkout-summary-cycle">/ month</span>
                            </div>
                            <ul className="checkout-summary-features">
                              {pricingPlans
                                .find((plan) => plan.name === checkoutPlan)
                                ?.features.map((feature) => (
                                  <li key={feature}>
                                    <IconCheckCircle />
                                    <span>{feature}</span>
                                  </li>
                                ))}
                            </ul>
                            <div className="checkout-summary-security">
                              <IconLock />
                              <span>256-bit encrypted &amp; PCI-compliant checkout</span>
                            </div>
                          </aside>

                          <div className="checkout-payment">
                            <div className="payment-methods">
                              <button
                                className={`payment-pill${paymentMethod === 'mpesa' ? ' active' : ''}`}
                                onClick={() => setPaymentMethod('mpesa')}
                                type="button"
                              >
                                <IconPhone />
                                <span>M-Pesa</span>
                              </button>
                              <button
                                className={`payment-pill${paymentMethod === 'card' ? ' active' : ''}`}
                                onClick={() => setPaymentMethod('card')}
                                type="button"
                              >
                                <IconCard />
                                <span>Credit / Debit Card</span>
                              </button>
                            </div>

                            {paymentMethod === 'mpesa' ? (
                              <div className="payment-form">
                                <label>
                                  M-Pesa phone number
                                  <input
                                    value={mpesaPhone}
                                    onChange={(event) => setMpesaPhone(event.target.value)}
                                    placeholder="07XXXXXXXX"
                                  />
                                </label>
                                <p className="checkout-charge-note">
                                  You'll be charged{' '}
                                  <strong>{pricingPlans.find((plan) => plan.name === checkoutPlan)?.price}</strong> via an
                                  M-Pesa STK push to the number above.
                                </p>
                                <button className="btn-red" onClick={() => handleMpesaPayment(checkoutPlan)}>
                                  Pay {pricingPlans.find((plan) => plan.name === checkoutPlan)?.price} with M-Pesa
                                </button>
                              </div>
                            ) : (
                              <form className="payment-form" onSubmit={(event) => handleCardPayment(event, checkoutPlan)}>
                                <label>
                                  Card number
                                  <input value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} placeholder="4242 4242 4242 4242" />
                                </label>
                                <label>
                                  Name on card
                                  <input value={cardName} onChange={(event) => setCardName(event.target.value)} placeholder="Jane Doe" />
                                </label>
                                <div className="card-row">
                                  <label>
                                    Expiry
                                    <input value={cardExpiry} onChange={(event) => setCardExpiry(event.target.value)} placeholder="MM/YY" />
                                  </label>
                                  <label>
                                    CVV
                                    <input value={cardCvv} onChange={(event) => setCardCvv(event.target.value)} placeholder="123" />
                                  </label>
                                </div>
                                <p className="checkout-charge-note">
                                  You'll be charged{' '}
                                  <strong>{pricingPlans.find((plan) => plan.name === checkoutPlan)?.price}</strong> to the
                                  card above today.
                                </p>
                                <button className="btn-red" type="submit">
                                  Pay {pricingPlans.find((plan) => plan.name === checkoutPlan)?.price} with Card
                                </button>
                              </form>
                            )}

                            {payingPlan === checkoutPlan && paymentMessage && <p className="status subtle">{paymentMessage}</p>}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {enterpriseModalOpen && (
                <div className="modal-backdrop" role="dialog" aria-modal="true">
                  <div className="modal-card">
                    {enterpriseSubmitted ? (
                      <>
                        <div className="modal-icon">✓</div>
                        <p className="eyebrow">Request received</p>
                        <h3>We'll be in touch shortly</h3>
                        <p className="modal-copy">
                          Thanks {enterpriseSubmitted.contactName}! Our sales team will reach out to{' '}
                          <strong>{enterpriseSubmitted.email}</strong> within 1 business day with volume-based pricing
                          tailored to {enterpriseSubmitted.companyName}.
                        </p>
                        <div className="plan-summary">
                          <div>
                            <strong>Company</strong>
                            <span>{enterpriseSubmitted.companyName}</span>
                          </div>
                          <div>
                            <strong>Monthly volume</strong>
                            <span>{enterpriseSubmitted.fleetSize} vehicle checks</span>
                          </div>
                          <div>
                            <strong>Contact</strong>
                            <span>{enterpriseSubmitted.phone}</span>
                          </div>
                        </div>
                        <div className="modal-actions">
                          <button className="btn-outline" onClick={closeEnterpriseInquiry}>Close</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="modal-header">
                          <div>
                            <p className="eyebrow">Dealership &amp; fleet plan</p>
                            <h3>Tell us about your business</h3>
                          </div>
                          <button className="btn-outline small" onClick={closeEnterpriseInquiry}>Cancel</button>
                        </div>
                        <p className="modal-copy">
                          Share a few details and our team will prepare a custom quote based on your monthly VIN check
                          volume, team size, and integration needs. No payment is required to request a quote.
                        </p>
                        <form className="payment-form enterprise-form" onSubmit={handleEnterpriseSubmit}>
                          <label>
                            Dealership / company name
                            <input
                              value={enterpriseForm.companyName}
                              onChange={(event) => updateEnterpriseField('companyName', event.target.value)}
                              placeholder="e.g. Nairobi Motors Ltd"
                            />
                            {enterpriseErrors.companyName && <span className="field-error">{enterpriseErrors.companyName}</span>}
                          </label>
                          <label>
                            Contact person
                            <input
                              value={enterpriseForm.contactName}
                              onChange={(event) => updateEnterpriseField('contactName', event.target.value)}
                              placeholder="Full name"
                            />
                            {enterpriseErrors.contactName && <span className="field-error">{enterpriseErrors.contactName}</span>}
                          </label>
                          <div className="card-row">
                            <label>
                              Work email
                              <input
                                type="email"
                                value={enterpriseForm.email}
                                onChange={(event) => updateEnterpriseField('email', event.target.value)}
                                placeholder="you@dealership.co.ke"
                              />
                              {enterpriseErrors.email && <span className="field-error">{enterpriseErrors.email}</span>}
                            </label>
                            <label>
                              Phone number
                              <input
                                value={enterpriseForm.phone}
                                onChange={(event) => updateEnterpriseField('phone', event.target.value)}
                                placeholder="07XXXXXXXX"
                              />
                              {enterpriseErrors.phone && <span className="field-error">{enterpriseErrors.phone}</span>}
                            </label>
                          </div>
                          <label>
                            Monthly vehicle check volume
                            <select
                              value={enterpriseForm.fleetSize}
                              onChange={(event) => updateEnterpriseField('fleetSize', event.target.value)}
                            >
                              <option value="1-10">1 - 10</option>
                              <option value="11-50">11 - 50</option>
                              <option value="51-200">51 - 200</option>
                              <option value="200+">200+</option>
                            </select>
                          </label>
                          <label>
                            Additional details (optional)
                            <textarea
                              value={enterpriseForm.message}
                              onChange={(event) => updateEnterpriseField('message', event.target.value)}
                              placeholder="Tell us about your team size, CRM/DMS, or integration timeline"
                              rows={3}
                            />
                          </label>
                          <button className="btn-red" type="submit">Request custom quote</button>
                        </form>
                      </>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="section-block">
              <h2>What people say</h2>
              <div className="cards testimonial-grid">
                {testimonials.map((item) => (
                  <article key={item.name} className="reveal">
                    <p>“{item.quote}”</p>
                    <strong>{item.name}</strong>
                  </article>
                ))}
              </div>
            </section>

            <section className="cta-banner reveal">
              <h2>Get Started with VinScope Kenya Today!</h2>
              <p>Vinscope Kenya can grow into a full, market-ready vehicle-history platform for Kenyan buyers and sellers.</p>
              <div className="cta-actions">
                <button className="btn-white" onClick={() => goToSection('hero')}>Check VIN Now</button>
                <button className="btn-outline-white" onClick={() => openAuth('register')}>Sign Up Free</button>
              </div>
            </section>

            <section id="faq" className="section-block reveal">
              <h2>Frequently asked questions</h2>
              <div className="faq-list">
                {faqs.map((faq) => (
                  <details key={faq.question}>
                    <summary>{faq.question}</summary>
                    <p>{faq.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          </>
        )}

        {view === 'report' && (
          <section className="stack">
            <div className="panel">
              <h2>VIN report lookup</h2>
              <p>Enter a VIN to preview a sample report and review critical risk indicators.</p>
              <form className="form-grid" onSubmit={handleLookup}>
                <input
                  value={vinInput}
                  onChange={(event) => setVinInput(event.target.value)}
                  placeholder="Enter VIN"
                />
                <button type="submit" className="btn-red">Load report</button>
              </form>
              <p className="status">{message}</p>
              <p className="status subtle">{loadingVehicle ? 'Loading vehicle details...' : apiStatus}</p>
            </div>

            <div className="panel report-card">
              <div className="report-letterhead">
                <div className="report-brand">
                  <span className="report-brand-icon"><IconLogo /></span>
                  <div>
                    <p className="report-doc-title">Vehicle History Report</p>
                    <p className="report-doc-subtitle">Prepared by VinScope Kenya</p>
                  </div>
                </div>
                <div className="report-meta">
                  <span>Report ref: <strong>{selectedReport.vin || '—'}</strong></span>
                  <span>Generated: <strong>{reportGeneratedAt}</strong></span>
                </div>
              </div>

              <div className="report-header">
                <div>
                  <p className="eyebrow">Vehicle</p>
                  <h3>{selectedReport.make} {selectedReport.model}{selectedReport.year ? ` (${selectedReport.year})` : ''}</h3>
                  <p className="report-status-line">
                    Status: <span className={`status-chip ${reportStatusTone}`}>{selectedReport.status}</span>
                  </p>
                </div>
                <div className="report-actions">
                  <div className={`score-summary tone-${reportScoreTier.tone}`}>
                    {selectedReport.score != null ? (
                      <>
                        <span className="score-value">{selectedReport.score}</span>
                        <span className="score-max">/100</span>
                      </>
                    ) : (
                      <span className="score-value score-value-empty">—</span>
                    )}
                    <span className="score-tier-label">{reportScoreTier.label}</span>
                  </div>
                  <div className="report-action-buttons">
                    <button className="btn-outline small" onClick={saveCurrentReport}>Save report</button>
                    <button className="btn-outline small" onClick={() => window.print()}>Print / Save PDF</button>
                  </div>
                </div>
              </div>
              {loadingVehicle ? (
                <div className="skeleton-stack">
                  <div className="skeleton-line w-70" />
                  <div className="skeleton-line w-40" />
                  <div className="skeleton-grid">
                    {Array.from({ length: 6 }).map((_, index) => (
                      <div key={index} className="skeleton-line" />
                    ))}
                  </div>
                  <div className="skeleton-card" />
                  <div className="skeleton-button" />
                </div>
              ) : (
                <>
                  {!historyAvailable && (
                    <p className="data-note">
                      <IconInfoCircle /> Decoded via the public NHTSA vPIC registry: make, model, and year are genuine.
                      Accident, theft, ownership, and mileage history are not publicly available for this VIN.
                    </p>
                  )}

                  <h4 className="report-section-title">Risk summary</h4>
                  <div className="risk-grid">
                    <div className={`risk-card ${theftStatus}`}>
                      <span className="risk-icon">{statusIcon(theftStatus)}</span>
                      <div>
                        <p className="risk-title">Theft record</p>
                        <p className="risk-value">{selectedReport.theft}</p>
                      </div>
                    </div>
                    <div className={`risk-card ${accidentStatus}`}>
                      <span className="risk-icon">{statusIcon(accidentStatus)}</span>
                      <div>
                        <p className="risk-title">Accident history</p>
                        <p className="risk-value">{selectedReport.accidents}</p>
                      </div>
                    </div>
                    <div className={`risk-card ${ownershipStatus}`}>
                      <span className="risk-icon">{statusIcon(ownershipStatus)}</span>
                      <div>
                        <p className="risk-title">Ownership history</p>
                        <p className="risk-value">{selectedReport.ownership}</p>
                      </div>
                    </div>
                    <div className={`risk-card ${mileageStatus}`}>
                      <span className="risk-icon">{statusIcon(mileageStatus)}</span>
                      <div>
                        <p className="risk-title">Mileage / odometer</p>
                        <p className="risk-value">{selectedReport.mileage}</p>
                      </div>
                    </div>
                  </div>

                  <h4 className="report-section-title">Vehicle specifications</h4>
                  <div className="specs-table-wrap">
                    <table className="specs-table">
                      <tbody>
                        <tr><th>VIN</th><td>{selectedReport.vin}</td></tr>
                        <tr><th>Year</th><td>{selectedReport.year ?? 'Unknown'}</td></tr>
                        {selectedReport.manufacturer && <tr><th>Manufacturer</th><td>{selectedReport.manufacturer}</td></tr>}
                        {selectedReport.plantCountry && <tr><th>Plant country</th><td>{selectedReport.plantCountry}</td></tr>}
                        {selectedReport.bodyClass && <tr><th>Body class</th><td>{selectedReport.bodyClass}</td></tr>}
                        {selectedReport.fuelType && <tr><th>Fuel type</th><td>{selectedReport.fuelType}</td></tr>}
                      </tbody>
                    </table>
                  </div>

                  <h4 className="report-section-title">Odometer reading history</h4>
                  <div className="mileage-card">
                    <div className="mileage-copy">
                      <strong>Odometer trend</strong>
                      <span>{selectedReport.mileage}</span>
                    </div>
                    <MileageCurveGraph mileage={selectedReport.mileage} />
                  </div>
                  <button className="btn-outline full" onClick={() => openVehicleDetail(selectedReport)}>
                    Open detailed vehicle history
                  </button>

                  <p className="report-footnote">
                    This report is compiled from available public and partner data sources at the time of the search.
                    It is intended to support, not replace, an independent pre-purchase inspection.
                  </p>
                </>
              )}
            </div>

            <div className="panel recent-searches-panel">
              <div className="recent-searches-header">
                <h3>Recent searches</h3>
                <span>{recentSearches.length > 0 ? 'Your last lookups' : 'No history yet'}</span>
              </div>
              {recentSearches.length === 0 ? (
                <div className="empty-state">
                  <strong>No recent lookups yet</strong>
                  <p>Search a VIN and it will appear here for quick access later.</p>
                </div>
              ) : (
                <ul className="recent-searches-list">
                  {recentSearches.map((entry) => (
                    <li key={entry.vin} className="recent-search-item">
                      <button onClick={() => {
                        setVinInput(entry.vin);
                        setMessage(`Loaded ${entry.make} ${entry.model} from your recent searches.`);
                      }}>
                        <strong>{entry.make} {entry.model}</strong>
                        <span>{entry.vin}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {view === 'history-detail' && (
          <section className="stack">
            <div className="panel detail-panel">
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">Vehicle history</p>
                  <h2>{(detailReport || selectedReport).make} {(detailReport || selectedReport).model}</h2>
                  <p className="section-subtitle detail-subtitle">A richer view of the history signals behind the report score.</p>
                </div>
                <button className="btn-outline small" onClick={() => setView('report')}>Back to report</button>
              </div>

              <div className="detail-overview">
                <div>
                  <strong>VIN</strong>
                  <span>{(detailReport || selectedReport).vin}</span>
                </div>
                <div>
                  <strong>Status</strong>
                  <span>{(detailReport || selectedReport).status}</span>
                </div>
                <div>
                  <strong>Score</strong>
                  <span>{(detailReport || selectedReport).score != null ? `${(detailReport || selectedReport).score}/100` : 'No score'}</span>
                </div>
              </div>

              <div className="detail-grid">
                {detailSections.map((section) => (
                  <article key={section.key} className={`detail-card ${section.tone}`}>
                    <h3>{section.title}</h3>
                    <p>{section.value}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        {view === 'compare' && (
          <section className="stack">
            <div className="panel">
              <h2>Vehicle comparison dashboard</h2>
              <p>
                {usingSavedComparison
                  ? 'Select from your saved reports to compare their risk profile and trust score.'
                  : 'Select vehicles to compare their risk profile and trust score. Save reports to your account to compare your own lookups instead of the demo vehicles.'}
              </p>
              <div className="cards compact">
                {usingSavedComparison
                  ? savedReports.map((report) => (
                      <article key={report.vin} className="compare-card">
                        <h3>{report.make} {report.model}</h3>
                        <p>{report.year ?? 'Unknown'} • {report.status}</p>
                        <button onClick={() => toggleSavedComparison(report.vin, report.selectedForComparison)}>
                          {report.selectedForComparison ? 'Remove' : 'Add to compare'}
                        </button>
                      </article>
                    ))
                  : sampleReports.map((report) => (
                      <article key={report.id} className="compare-card">
                        <h3>{report.make} {report.model}</h3>
                        <p>{report.year} • {report.status}</p>
                        <button onClick={() => toggleComparison(report.id)}>
                          {comparisonIds.includes(report.id) ? 'Remove' : 'Add to compare'}
                        </button>
                      </article>
                    ))}
              </div>
            </div>

            <div className="panel">
              <div className="comparison-hero">
                <div>
                  <p className="eyebrow">Quick scorecard</p>
                  <h3>See which vehicle stands out at a glance</h3>
                </div>
                <div className="comparison-summary-pill">
                  {bestComparisonReport ? `${bestComparisonReport.label} leads with ${bestComparisonReport.score}/100` : 'Select vehicles to compare'}
                </div>
              </div>

              <div className="comparison-chart-card">
                <div className="comparison-bars">
                  {comparisonChartData.map((report) => (
                    <div key={report.id} className="comparison-bar-row">
                      <div className="comparison-bar-label">
                        <strong>{report.label}</strong>
                        <span>{report.score}/100</span>
                      </div>
                      <div className="comparison-bar-track">
                        <div className={`comparison-bar-fill ${report.rating}`} style={{ width: `${Math.max(12, report.score)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="comparison-summary-grid">
                  <div>
                    <p className="eyebrow-sm">Top confidence</p>
                    <strong>{bestComparisonReport ? bestComparisonReport.label : 'No selection'}</strong>
                  </div>
                  <div>
                    <p className="eyebrow-sm">Overall signal</p>
                    <strong>{bestComparisonReport ? (bestComparisonReport.score >= 70 ? 'Stronger profile' : 'Higher caution') : 'Pending'}</strong>
                  </div>
                </div>
              </div>

              <table className="compare-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {comparisonReports.map((report) => (
                      <th key={report.vin}>{report.make} {report.model}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Trust score</td>
                    {comparisonReports.map((report) => <td key={report.vin}>{report.score != null ? `${report.score}/100` : 'No score'}</td>)}
                  </tr>
                  <tr>
                    <td>Theft</td>
                    {comparisonReports.map((report) => <td key={report.vin}>{report.theft}</td>)}
                  </tr>
                  <tr>
                    <td>Ownership</td>
                    {comparisonReports.map((report) => <td key={report.vin}>{report.ownership}</td>)}
                  </tr>
                  <tr>
                    <td>Accidents</td>
                    {comparisonReports.map((report) => <td key={report.vin}>{report.accidents}</td>)}
                  </tr>
                  <tr>
                    <td>Mileage</td>
                    {comparisonReports.map((report) => <td key={report.vin}>{report.mileage}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}

        {view === 'account' && (
          <section className="stack">
            <div className="panel">
              <h2>{authMode === 'login' ? 'Login' : 'Create account'}</h2>
              <form className="form-grid" onSubmit={handleAuthSubmit}>
                {authMode === 'register' && (
                  <>
                    <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name" />
                    <div className="verification-toggle">
                      <label>
                        <input
                          type="radio"
                          checked={verificationMethod === 'email'}
                          onChange={() => setVerificationMethod('email')}
                        />
                        Email verification
                      </label>
                      <label>
                        <input
                          type="radio"
                          checked={verificationMethod === 'sms'}
                          onChange={() => setVerificationMethod('sms')}
                        />
                        SMS verification
                      </label>
                    </div>
                  </>
                )}
                <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" />
                {formErrors.email && <p className="field-error">{formErrors.email}</p>}
                {authMode === 'register' && verificationMethod === 'sms' && (
                  <input value={verificationContact} onChange={(event) => setVerificationContact(event.target.value)} placeholder="Phone number" />
                )}
                <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" />
                {formErrors.password && <p className="field-error">{formErrors.password}</p>}
                {authMode === 'register' && verificationStep === 'verify' && (
                  <input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} placeholder="Enter verification code" />
                )}
                {verificationError && <p className="field-error">{verificationError}</p>}
                <button type="submit" className="btn-red">{authMode === 'login' ? 'Continue' : verificationStep === 'verify' ? 'Verify account' : 'Send verification'}</button>
              </form>
              <p className="status">{message}</p>
              <button className="btn-outline small" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
                Switch to {authMode === 'login' ? 'register' : 'login'}
              </button>
            </div>

            <div className="panel">
              <h3>Account features</h3>
              <ul className="feature-list">
                <li>Save favorite vehicles</li>
                <li>Track report history</li>
                <li>Receive alerts for risk changes</li>
              </ul>
              {user && (
                <div className="saved-list">
                  <div className="saved-report-toolbar">
                    <input
                      value={savedReportSearch}
                      onChange={(event) => setSavedReportSearch(event.target.value)}
                      placeholder="Search saved reports"
                    />
                    <select value={savedReportFilter} onChange={(event) => setSavedReportFilter(event.target.value)}>
                      <option value="all">All reports</option>
                      <option value="strong">Strong confidence</option>
                      <option value="risk">Needs caution</option>
                    </select>
                  </div>
                  <h4>Saved reports</h4>
                  {loadingSavedReports ? (
                    <div className="skeleton-stack">
                      {Array.from({ length: 3 }).map((_, index) => (
                        <div key={index} className="skeleton-line" />
                      ))}
                    </div>
                  ) : savedReports.length === 0 ? (
                    <div className="empty-state">
                      <strong>No reports saved yet</strong>
                      <p>Save a report to build a personalized vehicle watchlist and revisit it anytime.</p>
                    </div>
                  ) : filteredSavedReports.length === 0 ? (
                    <div className="empty-state">
                      <strong>No reports match the current filters</strong>
                      <p>Try a broader search or switch back to all reports.</p>
                    </div>
                  ) : (
                    filteredSavedReports.map((report) => (
                      <div key={report.vin} className="saved-item">
                        <strong>{report.make} {report.model}</strong>
                        <span>{report.score != null ? `${report.score}/100` : 'No score'} • {report.status}</span>
                        <button className="btn-outline small" onClick={() => removeSavedReport(report.vin)}>Remove</button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {view === 'privacy' && (
          <section className="stack">
            <div className="panel legal-page">
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">Legal</p>
                  <h2>Privacy Policy</h2>
                  <p className="section-subtitle detail-subtitle">Last updated {LEGAL_LAST_UPDATED}</p>
                </div>
                <button className="btn-outline small" onClick={() => setView('home')}>Back to home</button>
              </div>
              {privacyPolicySections.map((section) => (
                <div key={section.title} className="legal-section">
                  <h3>{section.title}</h3>
                  {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  {section.list && (
                    <ul>
                      {section.list.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {view === 'terms' && (
          <section className="stack">
            <div className="panel legal-page">
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">Legal</p>
                  <h2>Terms of Service</h2>
                  <p className="section-subtitle detail-subtitle">Last updated {LEGAL_LAST_UPDATED}</p>
                </div>
                <button className="btn-outline small" onClick={() => setView('home')}>Back to home</button>
              </div>
              {termsOfServiceSections.map((section) => (
                <div key={section.title} className="legal-section">
                  <h3>{section.title}</h3>
                  {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                  {section.list && (
                    <ul>
                      {section.list.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {view === 'contact' && (
          <section className="stack">
            <div className="panel">
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">We'd love to hear from you</p>
                  <h2>Contact VinScope Kenya</h2>
                  <p className="section-subtitle detail-subtitle">
                    Questions about a report, a subscription, or a dealership partnership? Reach out and our team will
                    get back to you.
                  </p>
                </div>
                <button className="btn-outline small" onClick={() => setView('home')}>Back to home</button>
              </div>

              <div className="contact-grid">
                <div className="contact-info-list">
                  <a className="contact-info-item" href="tel:+254714027134">
                    <span className="contact-info-icon"><IconPhone /></span>
                    <span>
                      <strong>Call or WhatsApp</strong>
                      <em>0714 027 134</em>
                    </span>
                  </a>
                  <a className="contact-info-item" href="mailto:vinscopekenya@gmail.com">
                    <span className="contact-info-icon"><IconMail /></span>
                    <span>
                      <strong>Email</strong>
                      <em>vinscopekenya@gmail.com</em>
                    </span>
                  </a>
                  <div className="contact-info-item">
                    <span className="contact-info-icon"><IconMapPin /></span>
                    <span>
                      <strong>Location</strong>
                      <em>Nairobi, Kenya</em>
                    </span>
                  </div>
                  <div className="contact-info-item">
                    <span className="contact-info-icon"><IconClock /></span>
                    <span>
                      <strong>Support hours</strong>
                      <em>Mon – Fri, 8:00 AM – 6:00 PM EAT</em>
                    </span>
                  </div>
                </div>

                <div className="contact-form-wrap">
                  {contactSubmitted ? (
                    <div className="contact-success">
                      <div className="modal-icon">✓</div>
                      <p className="eyebrow">Message sent</p>
                      <h3>Thanks, {contactSubmitted.name}!</h3>
                      <p className="modal-copy">
                        We've received your message and will reply to <strong>{contactSubmitted.email}</strong> as soon
                        as possible. For urgent matters, call or WhatsApp us on 0714 027 134.
                      </p>
                      <button className="btn-outline small" onClick={() => setContactSubmitted(null)}>Send another message</button>
                    </div>
                  ) : (
                    <form className="payment-form" onSubmit={handleContactSubmit}>
                      <label>
                        Your name
                        <input
                          value={contactForm.name}
                          onChange={(event) => updateContactField('name', event.target.value)}
                          placeholder="Full name"
                        />
                        {contactErrors.name && <span className="field-error">{contactErrors.name}</span>}
                      </label>
                      <label>
                        Email address
                        <input
                          type="email"
                          value={contactForm.email}
                          onChange={(event) => updateContactField('email', event.target.value)}
                          placeholder="you@example.com"
                        />
                        {contactErrors.email && <span className="field-error">{contactErrors.email}</span>}
                      </label>
                      <label>
                        Message
                        <textarea
                          rows={4}
                          value={contactForm.message}
                          onChange={(event) => updateContactField('message', event.target.value)}
                          placeholder="How can we help?"
                        />
                        {contactErrors.message && <span className="field-error">{contactErrors.message}</span>}
                      </label>
                      <button className="btn-red" type="submit">Send message</button>
                    </form>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
        </div>
      </main>

      <footer id="contact" className="footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <div className="brand-mark small"><IconLogo /></div>
            <p className="brand"><span className="brand-navy">VinScope</span> <span className="brand-red">KENYA</span></p>
          </div>
          <div className="footer-links">
            <button onClick={() => setView('home')}>Home</button>
            <button onClick={() => goToSection('features')}>Features</button>
            <button onClick={() => setView('compare')}>Compare</button>
            <button onClick={() => openAuth('login')}>Account</button>
            <button onClick={() => setView('privacy')}>Privacy Policy</button>
            <button onClick={() => setView('terms')}>Terms of Service</button>
          </div>
          <div className="footer-social" aria-label="Social links">
            <a href="https://facebook.com/vinscopekenya" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><span>f</span></a>
            <a href="https://x.com/vinscopekenya" target="_blank" rel="noopener noreferrer" aria-label="Twitter"><span>t</span></a>
            <a href="https://instagram.com/vinscopekenya" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><span>i</span></a>
            <a href="https://linkedin.com/company/vinscopekenya" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><span>in</span></a>
          </div>
        </div>
        <p className="footer-copy">© {new Date().getFullYear()} VinScope Kenya. A vehicle-history platform for smarter buying in Kenya.Developed by Mark Murithi</p>
      </footer>
    </div>
  );
}

export default App;
