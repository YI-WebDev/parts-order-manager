import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { installAppApi } from './tauri-api';
import './styles.css';

installAppApi();
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
