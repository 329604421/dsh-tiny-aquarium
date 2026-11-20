// Compares the shipped sidebar glyph with a taller variant at the sizes DSH
// uses, on light and dark sidebar backgrounds.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AquariumGlyph } from '../../src/client.jsx';

const tall = (withPellet) => React.createElement('svg', {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
  style: { display: 'block' },
},
  React.createElement('path', { d: 'M4.5 6.8h15v10a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3Z' }),
  React.createElement('path', { d: 'M5 11.6c2.4-1.7 4.8 1.7 7.2 0s4.6-1.2 6.6 0' }),
  React.createElement('path', { d: 'M12.8 2.8h6.5v4' }),
  withPellet ? React.createElement('circle', { cx: 8.4, cy: 16.2, r: 0.9 }) : null);

function Cell({ children }) {
  return React.createElement('span', { style: { display: 'grid', placeItems: 'center', width: 36, height: 36 } }, children);
}

function Row({ color, background }) {
  return React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', gap: 24, padding: '14px 22px', background, color },
  },
    [18, 24, 32].map(size => React.createElement(Cell, { key: 'cur' + size }, React.createElement(AquariumGlyph, { size }))),
    React.createElement('span', { style: { width: 14 } }),
    [18, 24, 32].map(size => React.createElement(Cell, { key: 'tall' + size },
      React.createElement('span', { style: { transform: `scale(${size / 18})` } }, tall(true)))),
    [18, 24, 32].map(size => React.createElement(Cell, { key: 'tall2' + size },
      React.createElement('span', { style: { transform: `scale(${size / 18})` } }, tall(false)))));
}

createRoot(document.getElementById('root')).render(React.createElement('div', null,
  React.createElement(Row, { color: '#4a5a50', background: '#f2f3ef' }),
  React.createElement(Row, { color: '#c9d3c6', background: '#1c211f' }),
));
