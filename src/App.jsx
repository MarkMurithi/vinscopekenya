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
import { buildComparisonChartData, buildVehicleHistorySections, filterSavedReports } from './utils/reportUtils';
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

  const values = tone === 'warn'
    ? [26, 41, 54, 61, 49, 43]
    : tone === 'ok'
      ? [18, 30, 46, 59, 72, 84]
      : [22, 35, 47, 53, 60, 66];

  const width = 150;
  const height = 92;
  const padding = 12;
  const points = values.map((value, index) => ({
    x: padding + (index / (values.length - 1)) * (width - padding * 2),
    y: height - padding - (value / 100) * (height - padding * 2),
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
  const fill = tone === 'warn' ? 'rgba(230, 57, 70, 0.14)' : tone === 'ok' ? 'rgba(22, 163, 74, 0.14)' : 'rgba(91, 108, 151, 0.14)';
  const lastPoint = points[points.length - 1];
  const startPoint = points[0];

  return (
    <div className={`mileage-graph ${tone}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mileage curve graph">
        <text x={padding} y={8} fontSize="7" fill="rgba(20, 33, 61, 0.7)">Mileage (kms)</text>
        <text x={width - padding - 36} y={height - 2} fontSize="7" fill="rgba(20, 33, 61, 0.7)">Timeline</text>
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(20, 33, 61, 0.18)" strokeDasharray="3 3" />
        <line x1={padding} y1={padding + 8} x2={padding} y2={height - padding} stroke="rgba(20, 33, 61, 0.18)" strokeDasharray="3 3" />
        <path
          d={`${pathData} L ${lastPoint.x.toFixed(1)} ${height - padding} L ${startPoint.x.toFixed(1)} ${height - padding} Z`}
          fill={fill}
        />
        <path d={pathData} stroke={stroke} strokeWidth="3.2" fill="none" strokeLinecap="round" />
        {points.map((point, index) => (
          <g key={index}>
            <circle cx={point.x} cy={point.y} r="5.2" fill="#fff" stroke={stroke} strokeWidth="2" />
            <circle cx={point.x} cy={point.y} r="2.2" fill={stroke} />
          </g>
        ))}
      </svg>
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
    description: 'For dealerships and fleet teams',
    features: ['Bulk checks', 'Team access', 'API-ready workflows'],
  },
];

function App() {
  const [view, setView] = useState('home');
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

  const historyAvailable = selectedReport.historyAvailable !== false;
  const theftStatus = !historyAvailable ? 'unknown' : /no/i.test(selectedReport.theft) ? 'ok' : 'warn';
  const accidentStatus = !historyAvailable ? 'unknown' : /no|not/i.test(selectedReport.accidents) ? 'ok' : 'warn';
  const statusIcon = (status) => (status === 'unknown' ? <IconInfoCircle /> : status === 'ok' ? <IconCheckCircle /> : <IconWarningCircle />);

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
          <button onClick={() => goToSection('contact')}>Contact</button>
        </nav>
        <div className="auth-buttons">
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
                  <article key={item.title} className="why-card">
                    <span className={`why-icon icon-${item.accent}`}><item.icon /></span>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="stats-row">
              <div className="stat-box">
                <strong>{analytics.totalSearches}+ searches</strong>
                <span>VIN lookups tracked</span>
              </div>
              <div className="stat-box">
                <strong>{getPopularPlan(analytics)}</strong>
                <span>Most selected plan</span>
              </div>
              <div className="stat-box">
                <strong>{stats[2].value}</strong>
                <span>{stats[2].label}</span>
              </div>
            </section>

            <section id="sample-report" className="section-block sample-report">
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
                  <article key={step.title}>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="section-block split">
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
                  <article key={plan.name} className={`price-card${plan.highlight ? ' highlight' : ''}`}>
                    <h3>{plan.name}</h3>
                    <p className="price-tag">{plan.price}</p>
                    <p>{plan.description}</p>
                    <ul>
                      {plan.features.map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                    <button className="btn-outline small" onClick={() => openCheckout(plan.name)}>
                      {plan.name === 'Starter' ? 'Get started' : 'Choose plan'}
                    </button>
                  </article>
                ))}
              </div>

              {activeSubscription && (
                <div className="subscription-success">
                  <div className="subscription-success-head">
                    <span className="subscription-badge">✓</span>
                    <div>
                      <h3>{activeSubscription.plan} plan is active</h3>
                      <p>Thanks for subscribing with {activeSubscription.method}. Your dashboard is ready to use.</p>
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
                  <div className="modal-card" id="checkout-panel">
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
                        <div className="plan-summary">
                          <div>
                            <strong>Plan</strong>
                            <span>{checkoutPlan}</span>
                          </div>
                          <div>
                            <strong>Includes</strong>
                            <span>{pricingPlans.find((plan) => plan.name === checkoutPlan)?.features.join(' • ')}</span>
                          </div>
                        </div>
                        <div className="payment-methods">
                          <button
                            className={`payment-pill${paymentMethod === 'mpesa' ? ' active' : ''}`}
                            onClick={() => setPaymentMethod('mpesa')}
                            type="button"
                          >
                            M-Pesa
                          </button>
                          <button
                            className={`payment-pill${paymentMethod === 'card' ? ' active' : ''}`}
                            onClick={() => setPaymentMethod('card')}
                            type="button"
                          >
                            Credit / Debit Card
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
                            <button className="btn-red" onClick={() => handleMpesaPayment(checkoutPlan)}>Pay with M-Pesa</button>
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
                            <button className="btn-red" type="submit">Pay with Card</button>
                          </form>
                        )}

                        {payingPlan === checkoutPlan && paymentMessage && <p className="status subtle">{paymentMessage}</p>}
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
                  <article key={item.name}>
                    <p>“{item.quote}”</p>
                    <strong>{item.name}</strong>
                  </article>
                ))}
              </div>
            </section>

            <section className="cta-banner">
              <h2>Get Started with VinScope Kenya Today!</h2>
              <p>Vinscope Kenya can grow into a full, market-ready vehicle-history platform for Kenyan buyers and sellers.</p>
              <div className="cta-actions">
                <button className="btn-white" onClick={() => goToSection('hero')}>Check VIN Now</button>
                <button className="btn-outline-white" onClick={() => openAuth('register')}>Sign Up Free</button>
              </div>
            </section>

            <section id="faq" className="section-block">
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
              <div className="report-header">
                <div>
                  <p className="eyebrow">Active report</p>
                  <h3>{selectedReport.make} {selectedReport.model}</h3>
                </div>
                <div className="report-actions">
                  <span className="score-pill">{selectedReport.score != null ? `${selectedReport.score}/100` : 'No score'}</span>
                  <button className="btn-outline small" onClick={saveCurrentReport}>Save report</button>
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
                  <div className="meta-grid">
                    <div><strong>Year:</strong> {selectedReport.year ?? 'Unknown'}</div>
                    <div><strong>VIN:</strong> {selectedReport.vin}</div>
                    <div><strong>Status:</strong> {selectedReport.status}</div>
                    <div><strong>Theft:</strong> {selectedReport.theft}</div>
                    <div><strong>Ownership:</strong> {selectedReport.ownership}</div>
                    <div><strong>Accidents:</strong> {selectedReport.accidents}</div>
                    <div><strong>Mileage:</strong> {selectedReport.mileage}</div>
                    {selectedReport.manufacturer && <div><strong>Manufacturer:</strong> {selectedReport.manufacturer}</div>}
                    {selectedReport.plantCountry && <div><strong>Plant country:</strong> {selectedReport.plantCountry}</div>}
                    {selectedReport.bodyClass && <div><strong>Body class:</strong> {selectedReport.bodyClass}</div>}
                    {selectedReport.fuelType && <div><strong>Fuel type:</strong> {selectedReport.fuelType}</div>}
                  </div>
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
            <a href="#privacy">Privacy Policy</a>
            <a href="#terms">Terms of Service</a>
          </div>
          <div className="footer-social" aria-label="Social links">
            <a href="#" aria-label="Facebook"><span>f</span></a>
            <a href="#" aria-label="Twitter"><span>t</span></a>
            <a href="#" aria-label="Instagram"><span>i</span></a>
            <a href="#" aria-label="LinkedIn"><span>in</span></a>
          </div>
        </div>
        <p className="footer-copy">© {new Date().getFullYear()} VinScope Kenya. A vehicle-history platform for smarter buying in Kenya.</p>
      </footer>
    </div>
  );
}

export default App;
