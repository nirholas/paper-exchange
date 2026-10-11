import { px, signedUsd, usd } from './fmt.js';

export interface CardData {
  market: string;
  side: 'long' | 'short';
  leverage: number;
  entry: number;
  exit: number;
  /** True while the position is still open: the exit is the live mark. */
  open: boolean;
  pnl: number;
  roePct: number;
  notional: number;
  trader: string;
  time: number;
}

export interface Theme {
  id: string;
  name: string;
  bg: [string, string];
  accent: string;
  glow: string;
}

export const THEMES: Theme[] = [
  { id: 'midnight', name: 'Midnight', bg: ['#04141b', '#0a2a33'], accent: '#2fe3c2', glow: 'rgba(47,227,194,0.28)' },
  { id: 'solana', name: 'Solana', bg: ['#150a2b', '#0b2b2a'], accent: '#9945ff', glow: 'rgba(20,241,149,0.25)' },
  { id: 'ember', name: 'Ember', bg: ['#1c0c08', '#3a1508'], accent: '#ff7a3d', glow: 'rgba(255,122,61,0.28)' },
  { id: 'carbon', name: 'Carbon', bg: ['#0c0c0e', '#1b1b20'], accent: '#e8e8ee', glow: 'rgba(255,255,255,0.12)' },
  { id: 'gold', name: 'Gold', bg: ['#161006', '#2c2008'], accent: '#f5c451', glow: 'rgba(245,196,81,0.26)' },
];

export const CARD_W = 1200;
export const CARD_H = 630;
const UP = '#2fe3c2';
const DOWN = '#ed7088';

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Draws the card. The PAPER watermark and footer are part of every render and cannot be switched off. */
export function drawCard(canvas: HTMLCanvasElement, d: CardData, theme: Theme, hideSize = false) {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const c = canvas.getContext('2d')!;
  const win = d.pnl >= 0;
  const tone = win ? UP : DOWN;

  const g = c.createLinearGradient(0, 0, CARD_W, CARD_H);
  g.addColorStop(0, theme.bg[0]);
  g.addColorStop(1, theme.bg[1]);
  c.fillStyle = g;
  c.fillRect(0, 0, CARD_W, CARD_H);

  const glow = c.createRadialGradient(CARD_W * 0.82, CARD_H * 0.25, 10, CARD_W * 0.82, CARD_H * 0.25, 520);
  glow.addColorStop(0, theme.glow);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, CARD_W, CARD_H);

  c.save();
  c.globalAlpha = 0.055;
  c.fillStyle = '#ffffff';
  c.font = '800 54px Inter, system-ui, sans-serif';
  c.translate(CARD_W / 2, CARD_H / 2);
  c.rotate(-0.38);
  for (let y = -700; y < 700; y += 120) for (let x = -1400; x < 1400; x += 420) c.fillText('PAPER', x + ((y / 120) % 2 ? 210 : 0), y);
  c.restore();

  c.strokeStyle = 'rgba(255,255,255,0.10)';
  c.lineWidth = 2;
  roundRect(c, 24, 24, CARD_W - 48, CARD_H - 48, 28);
  c.stroke();

  c.fillStyle = theme.accent;
  roundRect(c, 64, 62, 14, 14, 4);
  c.fill();
  c.fillStyle = '#ffffff';
  c.font = '700 26px Inter, system-ui, sans-serif';
  c.fillText('Paper Exchange', 90, 76);

  c.textAlign = 'right';
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.font = '500 22px Inter, system-ui, sans-serif';
  c.fillText(d.open ? 'OPEN POSITION' : 'CLOSED TRADE', CARD_W - 64, 76);
  c.textAlign = 'left';

  c.fillStyle = '#ffffff';
  c.font = '800 64px Inter, system-ui, sans-serif';
  c.fillText(`${d.market}-PERP`, 64, 168);
  const nameW = c.measureText(`${d.market}-PERP`).width;

  const tag = `${d.side.toUpperCase()}  ${d.leverage.toFixed(d.leverage % 1 ? 1 : 0)}x`;
  c.font = '700 26px Inter, system-ui, sans-serif';
  const tagW = c.measureText(tag).width + 32;
  c.fillStyle = d.side === 'long' ? 'rgba(47,227,194,0.16)' : 'rgba(237,112,136,0.16)';
  roundRect(c, 64 + nameW + 24, 126, tagW, 46, 12);
  c.fill();
  c.fillStyle = d.side === 'long' ? UP : DOWN;
  c.fillText(tag, 64 + nameW + 40, 159);

  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.font = '500 24px Inter, system-ui, sans-serif';
  c.fillText(d.open ? 'Unrealized ROE' : 'Return on margin', 64, 250);

  c.fillStyle = tone;
  c.font = '800 150px Inter, system-ui, sans-serif';
  c.fillText(`${d.roePct >= 0 ? '+' : ''}${d.roePct.toFixed(2)}%`, 58, 390);

  c.fillStyle = '#ffffff';
  c.font = '700 40px Inter, system-ui, sans-serif';
  c.fillText(hideSize ? (win ? 'In profit' : 'In drawdown') : signedUsd(d.pnl), 64, 450);

  const cols: [string, string][] = [
    ['Entry price', px(d.entry)],
    [d.open ? 'Mark price' : 'Exit price', px(d.exit)],
    ['Position', hideSize ? 'hidden' : usd(d.notional, 0)],
  ];
  cols.forEach(([label, value], i) => {
    const x = 64 + i * 270;
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.font = '500 20px Inter, system-ui, sans-serif';
    c.fillText(label, x, 512);
    c.fillStyle = '#ffffff';
    c.font = '700 30px Inter, system-ui, sans-serif';
    c.fillText(value, x, 550);
  });

  c.textAlign = 'right';
  c.fillStyle = 'rgba(255,255,255,0.8)';
  c.font = '700 22px Inter, system-ui, sans-serif';
  c.fillText(d.trader, CARD_W - 64, 520);
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.font = '500 20px Inter, system-ui, sans-serif';
  c.fillText(new Date(d.time).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }), CARD_W - 64, 550);
  c.textAlign = 'left';

  c.fillStyle = 'rgba(255,255,255,0.08)';
  c.fillRect(26, CARD_H - 74, CARD_W - 52, 40);
  c.fillStyle = 'rgba(255,255,255,0.7)';
  c.font = '600 17px Inter, system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('PAPER TRADE  -  SIMULATED FUNDS  -  LIVE HYPERLIQUID PRICES  -  NOT REAL MONEY', CARD_W / 2, CARD_H - 48);
  c.textAlign = 'left';
}

export function cardBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render the card.'))), 'image/png'));
}

export async function downloadCard(canvas: HTMLCanvasElement, name: string) {
  const blob = await cardBlob(canvas);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
}

export async function copyCard(canvas: HTMLCanvasElement) {
  const blob = await cardBlob(canvas);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
