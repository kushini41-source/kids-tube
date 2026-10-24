// 在這台電腦測試用：開 http://localhost:8765（直接雙擊 HTML 檔，YouTube 會拒絕播放）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const root = __dirname;
const port = 8765;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

http.createServer((req, res) => {
  let file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (file === '/') file = '/index.html';
  file = path.join(root, file);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`寶貝影片已啟動：${url}（關掉這個視窗就會停止）`);
  if (process.argv.includes('--open')) exec(`start "" ${url}`);
});
