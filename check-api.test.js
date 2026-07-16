const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchUrl, partitionSourceEntries } = require('./check_api');

test('configuration separates active and quarantined sources', () => {
  const result = partitionSourceEntries({
    active: { name: '启用', api: 'https://active.example/vod', detail: 'https://active.example' },
    quarantined: {
      name: '隔离',
      api: 'https://quarantined.example/vod',
      detail: 'https://quarantined.example',
      _comment: '无法搜索',
    },
  });
  assert.equal(result.allEntries.length, 2);
  assert.deepEqual(result.activeEntries.map(source => source.name), ['启用']);
  assert.deepEqual(result.quarantinedEntries.map(source => source.quarantineReason), ['无法搜索']);
});

test('search parameters are appended without corrupting existing query strings', () => {
  assert.equal(
    buildSearchUrl('https://example.com/api.php/provide/vod', '你好'),
    'https://example.com/api.php/provide/vod?ac=videolist&wd=%E4%BD%A0%E5%A5%BD'
  );
  assert.equal(
    buildSearchUrl('https://proxy.example/?url=https://source.example/vod', '你好'),
    'https://proxy.example/?url=https://source.example/vod&ac=videolist&wd=%E4%BD%A0%E5%A5%BD'
  );
});
