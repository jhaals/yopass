import FeaturesSection from '@shared/components/FeaturesSection';
import CreateSecret from '@features/CreateSecret';
import { Routes, Route, HashRouter } from 'react-router-dom';
import { useConfig } from '@shared/hooks/useConfig';
import Navbar from '@shared/components/Navbar';
import Prefetcher from '@features/display-secret/Prefetcher';
import Upload from '@features/Upload';

export default function App() {
  const { DISABLE_UPLOAD } = useConfig();
  return (
    <div className="min-h-screen bg-base-200">
      <Navbar />

      {/* Main Content */}
      <HashRouter>
        <div className="container mx-auto px-4 py-8">
          <div className="card bg-base-100 shadow-xl">
            <div className="card-body">
              <Routes>
                <Route path="/" element={<CreateSecret />} />
                {!DISABLE_UPLOAD && (
                  <Route path="/upload" element={<Upload />} />
                )}
                <Route
                  path="/:format/:key/:password"
                  element={<Prefetcher />}
                />
                <Route path="/:format/:key" element={<Prefetcher />} />
              </Routes>
            </div>
          </div>
          <FeaturesSection />
        </div>
      </HashRouter>
      {/* Footer */}
      <footer className="footer footer-center p-10 bg-base-200 text-base-content">
        <div className="max-w-3xl text-center">
          <p className="text-sm text-base-content/60">
            Created by{' '}
            <a href="https://github.com/jhaals" className="link">
              Johan Haals
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
