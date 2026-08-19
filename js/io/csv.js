// CSV 文件导入辅助函数。
function parseCSV(text) {
  text = text.trim();
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.split('\n').filter(Boolean).map(function (l) {
    return l.split(',').map(function (c) { return c.trim().replace(/^"|"$/g, ''); });
  });
}
