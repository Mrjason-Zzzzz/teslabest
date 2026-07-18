/* global self, importScripts */
// Decoder.js 是 Node.js 打包产物，会引用 `global` 变量，
// 但 Web Worker 的全局对象是 `self`，没有 `global`，
// 所以需要在加载 Decoder.js 之前 polyfill。
self.global = self;
importScripts('./Decoder.js');