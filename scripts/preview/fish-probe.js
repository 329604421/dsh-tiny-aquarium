// P2 鱼的独立验证页：不加载聊天外壳，只跑 createScene + 鱼群，
// 把 snapshot 里的 fish / fishState 读回来做程序化判定（不靠肉眼数鱼）。
import { createScene } from '../../src/scene.js';

const root = document.getElementById('root');
const logs = [];
const api = createScene(root, {
  canvasLabel: 'probe',
  onFish: n => logs.push('FISH_READY ' + n),
  onFishError: e => logs.push('FISH_ERR ' + e),
});

window.__api = api;
window.__logs = logs;
window.__snap = () => api.snapshot();
