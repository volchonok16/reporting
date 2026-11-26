import { initReportingTheme } from './reporting';
import React from 'react';
import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import './design/components.css';
import './design/reporting.css';
import { App } from './app/App';

initReportingTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
