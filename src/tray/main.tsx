import { createRoot } from 'react-dom/client';
import '../styles.css';
import './tray.css';
import TrayApp from './TrayApp';

createRoot(document.getElementById('root')!).render(<TrayApp />);
