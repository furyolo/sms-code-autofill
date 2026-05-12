import { h, render } from 'preact';
import App from './App';

// 挂载 Preact App 到 #app 节点
const root = document.getElementById('app');
if (root) {
  render(h(App, null), root);
}
