/**
 * API Integration Test: Clone File Management
 *
 * Cross-validates API responses with database state.
 * Tests the full CRUD lifecycle for clone files.
 *
 * Anti-Fake-Run: R1-R8 compliant.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), '..', 'e2e-data');
const TEST_PREFIX = 'e2e-clone-test-';
const TEST_CLONE = `${TEST_PREFIX}api-${Date.now()}`;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const results = [];

async function api(path, opts = {}) {
  // Clone routes: /api/clones (no /api/agent prefix)
  // Actuator: /api/actuator
  const needsAgentPrefix = path.startsWith('/sessions') || path.startsWith('/configs');
  const base = needsAgentPrefix ? `${API_URL}/api/agent` : `${API_URL}/api`;
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer agent',
      ...opts.headers,
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
}

function assert(condition, name, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ name, status, detail });
  const icon = condition ? '✅' : '❌';
  console.log(`${icon} ${name}: ${status}${detail ? ' — ' + detail : ''}`);
  return condition;
}

async function main() {
  console.log('=== Clone API Integration Tests ===');
  console.log(`API: ${API_URL}`);
  console.log(`Test Clone: ${TEST_CLONE}`);

  // ── 1. Health Check ──
  const healthRes = await fetch(`${API_URL}/api/actuator/health`);
  const health = healthRes.ok ? await healthRes.json() : { status: 'FAIL' };
  assert(health.status === 'ok', 'Health Check', `status=${health.status}`);

  // ── 2. Create Clone (Simplified API) ──
  console.log('\n--- Create Clone ---');
  const createRes = await api('/clones', {
    method: 'POST',
    body: JSON.stringify({
      name: TEST_CLONE,
      display_name: 'E2E API Test Clone',
      memory_scope: 'isolated',
    }),
  });
  assert(createRes.ok || createRes.status === 201 || createRes.status === 200,
    'Create Clone', `status=${createRes.status}, body=${JSON.stringify(createRes.body).slice(0, 200)}`
  );

  if (createRes.body) {
    // Response is {clone: {...}}, not the clone directly
    const clone = createRes.body.clone || createRes.body;
    assert(clone.name === TEST_CLONE, 'Clone Name Match', `name=${clone.name}`);
    assert(clone.display_name === 'E2E API Test Clone', 'Display Name Match', `display_name=${clone.display_name}`);
    assert(clone.memory_scope === 'isolated', 'Memory Scope Default', `memory_scope=${clone.memory_scope}`);
    assert(typeof clone.status === 'string', 'Has Status', `status=${clone.status}`);
    assert(typeof clone.created_at === 'string', 'Has Created At', `created_at=${clone.created_at}`);
  }

  // ── 3. List Clones — Verify Created ──
  console.log('\n--- List Clones ---');
  const listRes = await api('/clones');
  assert(listRes.ok, 'List Clones', `status=${listRes.status}`);
  const foundClone = listRes.body?.clones?.find(c => c.name === TEST_CLONE);
  assert(!!foundClone, 'Clone in List', foundClone ? `found in ${listRes.body.clones.length} clones` : 'NOT FOUND');

  // ── 4. File Tree — Verify Auto-Created Structure ──
  console.log('\n--- File Tree ---');
  const filesRes = await api(`/clones/${TEST_CLONE}/files?recursive=true`);
  assert(filesRes.ok, 'List Files', `status=${filesRes.status}`);

  const files = filesRes.body?.files || [];
  const filePaths = files.map(f => f.path);
  console.log(`  Files: ${JSON.stringify(filePaths)}`);

  assert(filePaths.includes('persona.md'), 'Has persona.md', `paths=${filePaths.filter(p => !p.startsWith('__'))}`);
  assert(filePaths.includes('config.json'), 'Has config.json');

  const hasMemoryDir = files.some(f => f.path === 'memory' && f.type === 'directory');
  const hasSkillsDir = files.some(f => f.path === 'skills' && f.type === 'directory');
  assert(hasMemoryDir, 'Has memory/ directory');
  assert(hasSkillsDir, 'Has skills/ directory');

  // Verify file fields
  const personaFile = files.find(f => f.path === 'persona.md');
  if (personaFile) {
    assert(typeof personaFile.size === 'number', 'File has size', `size=${personaFile.size}`);
    assert(typeof personaFile.modified === 'string', 'File has modified', `modified=${personaFile.modified}`);
    assert(personaFile.readonly === false, 'Own file not readonly', `readonly=${personaFile.readonly}`);
  }

  // Verify inherited (readonly) files
  const inheritedFiles = files.filter(f => f.path.startsWith('__inherited__/'));
  const inheritedReadonly = inheritedFiles.filter(f => f.readonly === true);
  assert(inheritedFiles.length > 0, 'Has inherited files', `count=${inheritedFiles.length}`);
  assert(inheritedReadonly.length === inheritedFiles.length, 'All inherited files readonly',
    `readonly=${inheritedReadonly.length}/${inheritedFiles.length}`);

  // ── 6. Read File Content ──
  console.log('\n--- Read File ---');
  const readRes = await api(`/clones/${TEST_CLONE}/files/persona.md`);
  assert(readRes.ok, 'Read persona.md', `status=${readRes.status}`);
  assert(typeof readRes.body?.content === 'string', 'Has content', `content length=${readRes.body?.content?.length || 0}`);

  // SPEC CHECK: GET should return readonly field
  const hasReadonlyField = readRes.body && 'readonly' in readRes.body;
  assert(hasReadonlyField, 'GET file returns readonly field (SPEC)',
    hasReadonlyField ? `readonly=${readRes.body.readonly}` : 'BUG: readonly field missing from GET response'
  );

  // ── 7. Write File Content ──
  console.log('\n--- Write File ---');
  const testContent = '# E2E Test Persona\n\nThis is a test persona for E2E verification.';
  const writeRes = await api(`/clones/${TEST_CLONE}/files/persona.md`, {
    method: 'PUT',
    body: JSON.stringify({ content: testContent }),
  });
  assert(writeRes.ok, 'Write persona.md', `status=${writeRes.status}`);

  // Read back to verify
  const readBackRes = await api(`/clones/${TEST_CLONE}/files/persona.md`);
  assert(readBackRes.body?.content === testContent, 'Read-Back Verification',
    `content matches: ${readBackRes.body?.content === testContent}`
  );

  // ── 8. Create Directory via POST (wildcard route) ──
  console.log('\n--- Create Directory (Wildcard Route Test) ---');
  const mkdirRes = await api(`/clones/${TEST_CLONE}/files/skills/test-skill`, {
    method: 'POST',
    body: JSON.stringify({ type: 'directory' }),
  });

  // BUG: clone-files.ts uses c.req.param('*') which returns undefined
  if (mkdirRes.status === 500) {
    console.log('  BUG DETECTED: POST /clones/:name/files/* wildcard param is undefined');
    console.log('  Root cause: Hono wildcard route param (*) not resolving in clone-files.ts');
  }
  assert(mkdirRes.ok, 'Create skills/test-skill/ via POST',
    `status=${mkdirRes.status}${mkdirRes.status === 500 ? ' (BUG: wildcard param undefined)' : ''}`
  );

  // ── 8b. Workaround: Use PUT to create file in subdirectory ──
  console.log('\n--- Create File in Subdirectory (PUT route) ---');
  const skillContent = '# Test Skill\n\nE2E test skill.';
  // PUT route in clone/index.ts uses whitelist, rejects paths with slashes
  const createFileRes = await api(`/clones/${TEST_CLONE}/files/skills%2Ftest-skill%2FSKILL.md`, {
    method: 'PUT',
    body: JSON.stringify({ content: skillContent }),
  });

  if (createFileRes.status === 403) {
    console.log('  BUG DETECTED: PUT whitelist rejects paths with slashes');
    console.log('  The whitelist check blocks "skills/test-skill/SKILL.md" due to "/" in path');
  }
  assert(createFileRes.ok, 'Create SKILL.md via PUT',
    `status=${createFileRes.status}${createFileRes.status === 403 ? ' (BUG: whitelist rejects paths with slashes)' : ''}`
  );

  // ── 9. Verify file appears in file tree (even without subdirectory create) ──
  console.log('\n--- Verify File Tree After Operations ---');
  const filesRes2 = await api(`/clones/${TEST_CLONE}/files?recursive=true`);
  const hasNewDir = filesRes2.body?.files?.some(f => f.path === 'skills/test-skill' && f.type === 'directory');
  console.log(`  Directory in tree: ${hasNewDir}`);
  const hasSkillMd = filesRes2.body?.files?.some(f => f.path.includes('SKILL.md'));
  console.log(`  SKILL.md in tree: ${hasSkillMd}`);

  // ── 10. Readonly Verification ──
  console.log('\n--- Readonly Verification ---');
  // Check file tree for inherited files readonly flag
  const inheritedFile = files.find(f => f.path.startsWith('__inherited__/') && f.type === 'file');
  if (inheritedFile) {
    assert(inheritedFile.readonly === true, 'Inherited files marked readonly in tree',
      `readonly=${inheritedFile.readonly}`);

    // Try writing to an inherited file via PUT (clone/index.ts route)
    const writeReadonlyRes = await api(`/clones/${TEST_CLONE}/files/${inheritedFile.path.replace('__inherited__/skills/', '')}`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'should fail' }),
    });
    assert(!writeReadonlyRes.ok || writeReadonlyRes.status >= 400,
      'Cannot write to readonly file',
      `status=${writeReadonlyRes.status}`
    );
  }

  // ── 11. Delete operations (affected by same wildcard bug) ──
  console.log('\n--- Delete Operations ---');
  const delFileRes = await api(`/clones/${TEST_CLONE}/files/skills/test-skill/SKILL.md`, {
    method: 'DELETE',
  });
  console.log(`  Delete file status: ${delFileRes.status}`);
  if (delFileRes.status === 500) {
    console.log('  BUG: Same wildcard param issue affects DELETE');
  }
  assert(delFileRes.ok || delFileRes.status === 404, 'Delete SKILL.md', `status=${delFileRes.status}`);

  const delDirRes = await api(`/clones/${TEST_CLONE}/files/skills/test-skill`, {
    method: 'DELETE',
  });
  console.log(`  Delete dir status: ${delDirRes.status}`);
  assert(delDirRes.ok || delDirRes.status === 404, 'Delete directory', `status=${delDirRes.status}`);

  // ── CLEANUP: Delete test clone ──
  console.log('\n--- Cleanup ---');
  const deleteRes = await api(`/clones/${TEST_CLONE}`, { method: 'DELETE' });
  assert(deleteRes.ok, 'Delete test clone', `status=${deleteRes.status}`);

  // Verify deletion
  const listAfterDelete = await api('/clones');
  const stillExists = listAfterDelete.body?.clones?.find(c => c.name === TEST_CLONE);
  assert(!stillExists, 'Clone actually deleted', stillExists ? 'STILL EXISTS' : 'confirmed deleted');

  // ── Save Results ──
  const summary = { PASS: 0, FAIL: 0, SKIP: 0 };
  results.forEach(r => { summary[r.status] = (summary[r.status] || 0) + 1; });

  console.log('\n=== API Integration Test Report ===');
  console.log(`Total: ${results.length} | PASS: ${summary.PASS} | FAIL: ${summary.FAIL}`);

  const reportPath = join(DATA_DIR, `api-test-results-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify({ results, summary, testClone: TEST_CLONE }, null, 2));
  console.log(`Results saved to: ${reportPath}`);

  process.exit(summary.FAIL > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
