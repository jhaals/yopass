"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = formatRelative;
var formatRelativeLocale = {
  lastWeek: 'せんしゅうのeeeeのp',
  yesterday: 'きのうのp',
  today: 'きょうのp',
  tomorrow: 'あしたのp',
  nextWeek: 'よくしゅうのeeeeのp',
  other: 'P'
};

function formatRelative(token, _date, _baseDate, _options) {
  return formatRelativeLocale[token];
}

module.exports = exports.default;