const Database = require('better-sqlite3');
const db = new Database('/home/xzf/.octopus/db/octopus-feat-knowledge-system.db');

const action = process.argv[2];

function uuid() {
  return 'e2e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

switch (action) {
  case 'insert-pending': {
    const type = process.argv[3] || 'rule';
    const count = parseInt(process.argv[4] || '1');
    const conflicts = process.argv[5] || null;
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = uuid();
      ids.push(id);
      db.prepare(`INSERT INTO pending_review (id, type, source, source_ref, source_label, content, target_file, scope, conflicts, confidence, auto_approve, status, user_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, type, 'system', '', 'E2E Test',
        `E2E test ${type} #${i+1}: This is a test ${type} content for verification`,
        'test.md', 'project',
        conflicts, 0.8, 0, 'pending', null
      );
    }
    console.log(JSON.stringify({ ok: true, ids }));
    break;
  }
  case 'clean-pending': {
    const result = db.prepare("DELETE FROM pending_review WHERE source = 'system' AND source_label = 'E2E Test'").run();
    console.log(JSON.stringify({ ok: true, deleted: result.changes }));
    break;
  }
  case 'clean-all-pending': {
    const result = db.prepare("DELETE FROM pending_review WHERE id LIKE 'e2e-%'").run();
    console.log(JSON.stringify({ ok: true, deleted: result.changes }));
    break;
  }
  case 'count-pending': {
    const total = db.prepare("SELECT COUNT(*) as cnt FROM pending_review WHERE status IN ('pending', 'deferred')").get();
    const byType = db.prepare("SELECT type, COUNT(*) as cnt FROM pending_review WHERE status IN ('pending', 'deferred') GROUP BY type").all();
    console.log(JSON.stringify({ total: total.cnt, byType }));
    break;
  }
  case 'list-pending': {
    const items = db.prepare("SELECT id, type, status, conflicts FROM pending_review WHERE status IN ('pending', 'deferred') ORDER BY created_at DESC").all();
    console.log(JSON.stringify(items));
    break;
  }
  default:
    console.log('Usage: node e2e-test-helper.js <insert-pending|clean-pending|clean-all-pending|count-pending|list-pending> [type] [count] [conflicts]');
}

db.close();
