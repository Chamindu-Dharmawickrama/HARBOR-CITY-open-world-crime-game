import './ui/styles.css';
import { startGame } from './game/game';
import { parseUrlParams } from './game/url-params';
import { showFatalError } from './ui/fatal-error';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

startGame(root, parseUrlParams(window.location.search)).catch((error: unknown) => {
  console.error(error);
  showFatalError(root, error);
});
