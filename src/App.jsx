import { useMemo, useState } from 'react';
import './index.css';
import { getVehicleReports, loginUser, registerUser, saveVehicleReport } from './services/mockApi';
import { lookupVehicleByVin, pingVehicleApi } from './services/vehicleApi';

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
  },
];

const highlightCards = [
  { title: 'Damage & repairs', text: 'Reveal structural or cosmetic repairs and prior incidents.' },
  { title: 'Mileage checks', text: 'Validate odometer history and spot suspicious inconsistencies.' },
  { title: 'Ownership history', text: 'Understand how many owners the vehicle has had over time.' },
  { title: 'Theft & alerts', text: 'Surface theft flags and high-risk indicators before purchase.' },
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
  const [apiStatus, setApiStatus] = useState('Checking API...');

  const comparisonReports = useMemo(
    () => sampleReports.filter((report) => comparisonIds.includes(report.id)),
    [comparisonIds]
  );

  const handleAuthSubmit = (event) => {
    event.preventDefault();

    if (authMode === 'login') {
      const result = loginUser(email, password);
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      const currentUser = { name: result.user.name, email: result.user.email };
      setUser(currentUser);
      setSavedReports(getVehicleReports(result.user.email));
      setMessage(`Welcome back, ${currentUser.name}.`);
      setView('report');
      return;
    }

    const result = registerUser(email, password, name || 'New Buyer');
    if (!result.success) {
      setMessage(result.message);
      return;
    }

    const currentUser = { name: result.user.name, email: result.user.email };
    setUser(currentUser);
    setSavedReports(getVehicleReports(result.user.email));
    setMessage('Account created. You can now access reports.');
    setView('report');
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
      };

      setSelectedReport(mappedReport);
      setMessage(`Vehicle data retrieved for ${mappedReport.make} ${mappedReport.model}.`);
      setView('report');
    } catch (error) {
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

  const saveCurrentReport = () => {
    if (!user?.email) {
      setMessage('Sign in first to save a report.');
      return;
    }

    saveVehicleReport(selectedReport, user.email);
    setSavedReports(getVehicleReports(user.email));
    setMessage(`Saved ${selectedReport.make} ${selectedReport.model} to your account.`);
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-mark">VK</div>
          <div>
            <p className="brand">Vinscope Kenya</p>
            <span className="brand-subtitle">Vehicle history intelligence</span>
          </div>
        </div>
        <nav className="nav-links" aria-label="Main navigation">
          <button onClick={() => setView('home')}>Home</button>
          <button onClick={() => setView('report')}>Reports</button>
          <button onClick={() => setView('compare')}>Compare</button>
          <button onClick={() => setView('account')}>Account</button>
        </nav>
      </header>

      <main className="page">
        {view === 'home' && (
          <>
            <section className="hero-card">
              <div className="hero-copy">
                <p className="eyebrow">Trust data, not words</p>
                <h1>Check any vehicle’s history in seconds.</h1>
                <p className="subtitle">
                  Vinscope Kenya gives buyers and sellers a clearer view of a used vehicle through VIN decoding, verified signals, and a risk-focused report experience.
                </p>
                <form className="hero-search" onSubmit={handleLookup}>
                  <input
                    value={vinInput}
                    onChange={(event) => setVinInput(event.target.value)}
                    placeholder="Enter VIN"
                  />
                  <button type="submit" className="primary">Get report</button>
                </form>
                <p className="status">{message}</p>
                <p className="status subtle">{loadingVehicle ? 'Loading vehicle details...' : apiStatus}</p>
              </div>
              <div className="hero-side">
                <div className="hero-side-card">
                  <h3>What the report can uncover</h3>
                  <ul>
                    <li>Accident and repair history</li>
                    <li>Theft or stolen status alerts</li>
                    <li>Ownership inconsistencies</li>
                    <li>Mileage irregularities</li>
                  </ul>
                </div>
              </div>
            </section>

            <section className="stats-row">
              {stats.map((stat) => (
                <div key={stat.label} className="stat-box">
                  <strong>{stat.value}</strong>
                  <span>{stat.label}</span>
                </div>
              ))}
            </section>

            <section className="section-block">
              <h2>Why smart buyers start with Vinscope Kenya</h2>
              <div className="cards">
                {highlightCards.map((item) => (
                  <article key={item.title}>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
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
              <h2>How it works</h2>
              <div className="cards">
                {steps.map((step) => (
                  <article key={step.title}>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </article>
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
                  </article>
                ))}
              </div>
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

            <section className="section-block cta-banner">
              <h2>Ready to explore the concept?</h2>
              <p>Vinscope Kenya can grow into a full, market-ready vehicle-history platform for Kenyan buyers and sellers.</p>
              <button className="primary" onClick={() => setView('report')}>Try the demo</button>
            </section>

            <section className="section-block">
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
                <button type="submit" className="primary">Load report</button>
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
                  <span className="score-pill">{selectedReport.score}/100</span>
                  <button className="secondary small" onClick={saveCurrentReport}>Save report</button>
                </div>
              </div>
              <div className="meta-grid">
                <div><strong>Year:</strong> {selectedReport.year}</div>
                <div><strong>VIN:</strong> {selectedReport.vin}</div>
                <div><strong>Status:</strong> {selectedReport.status}</div>
                <div><strong>Theft:</strong> {selectedReport.theft}</div>
                <div><strong>Ownership:</strong> {selectedReport.ownership}</div>
                <div><strong>Accidents:</strong> {selectedReport.accidents}</div>
                <div><strong>Mileage:</strong> {selectedReport.mileage}</div>
              </div>
            </div>
          </section>
        )}

        {view === 'compare' && (
          <section className="stack">
            <div className="panel">
              <h2>Vehicle comparison dashboard</h2>
              <p>Select vehicles to compare their risk profile and trust score.</p>
              <div className="cards compact">
                {sampleReports.map((report) => (
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
              <table className="compare-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {comparisonReports.map((report) => (
                      <th key={report.id}>{report.make} {report.model}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Trust score</td>
                    {comparisonReports.map((report) => <td key={report.id}>{report.score}/100</td>)}
                  </tr>
                  <tr>
                    <td>Theft</td>
                    {comparisonReports.map((report) => <td key={report.id}>{report.theft}</td>)}
                  </tr>
                  <tr>
                    <td>Ownership</td>
                    {comparisonReports.map((report) => <td key={report.id}>{report.ownership}</td>)}
                  </tr>
                  <tr>
                    <td>Accidents</td>
                    {comparisonReports.map((report) => <td key={report.id}>{report.accidents}</td>)}
                  </tr>
                  <tr>
                    <td>Mileage</td>
                    {comparisonReports.map((report) => <td key={report.id}>{report.mileage}</td>)}
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
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name" />
                )}
                <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" />
                <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" />
                <button type="submit" className="primary">{authMode === 'login' ? 'Continue' : 'Register'}</button>
              </form>
              <p className="status">{message}</p>
              <button className="secondary small" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
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
                  <h4>Saved reports</h4>
                  {savedReports.length === 0 ? (
                    <p>No reports saved yet.</p>
                  ) : (
                    savedReports.map((report) => (
                      <div key={report.id} className="saved-item">
                        <strong>{report.make} {report.model}</strong>
                        <span>{report.score}/100 • {report.status}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <div className="footer-card">
          <div>
            <p className="brand">Vinscope Kenya</p>
            <p>A vehicle-history platform concept for smarter buying in Kenya.</p>
          </div>
          <div className="footer-links">
            <button onClick={() => setView('home')}>Home</button>
            <button onClick={() => setView('report')}>Reports</button>
            <button onClick={() => setView('compare')}>Compare</button>
            <button onClick={() => setView('account')}>Account</button>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
