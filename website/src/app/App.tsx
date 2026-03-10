import CreateSecret from '@features/CreateSecret';
import { Routes, Route, HashRouter } from 'react-router-dom';
import { useConfig } from '@shared/hooks/useConfig';
import Navbar from '@shared/components/Navbar';
import Prefetcher from '@features/display-secret/Prefetcher';
import Upload from '@features/Upload';

export default function App() {
  const { DISABLE_UPLOAD } = useConfig();
  return (
    <div className="min-h-screen bg-base-200 flex flex-col">
      <HashRouter>
        <Navbar />

        {/* Main Content */}
        <div className="container mx-auto mb-auto px-4 py-8">
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
        </div>
      </HashRouter>
      {/* Footer */}
      <footer className="bg-base-100 border-t border-base-300">
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-wrap items-center justify-center gap-4 text-sm text-base-content/70">
            <a
              href="https://tobsen-it.de/impressum"
              className="hover:text-primary transition-colors duration-200"
              target="_blank"
              rel="noopener noreferrer"
            >
              Impressum
            </a>
            <span className="text-base-content/40">|</span>
            <a
              href="https://tobsen-it.de/datenschutz"
              className="hover:text-primary transition-colors duration-200"
              target="_blank"
              rel="noopener noreferrer"
            >
              Datenschutz
            </a>
            <span className="text-base-content/40">|</span>
            <span>
              &copy; {new Date().getFullYear()}{' '}
              <a
                href="https://tobsen-it.de"
                className="hover:text-primary transition-colors duration-200"
                target="_blank"
                rel="noopener noreferrer"
              >
                Tobsen IT
              </a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
