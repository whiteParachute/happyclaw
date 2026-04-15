// Skills management routes

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import AdmZip from 'adm-zip';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { DATA_DIR } from '../config.js';

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project';
  enabled: boolean;
  syncedFromHost?: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface HostSyncManifest {
  syncedSkills: string[];
  lastSyncAt: string;
}

interface SkillsManifest {
  skills: Record<
    string,
    {
      packageName: string;
      installedAt: string;
      source: string;
    }
  >;
}

// --- Utility Functions ---

function getUserSkillsDir(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

function getProjectSkillsDir(): string {
  return path.resolve(process.cwd(), 'container', 'skills');
}

function getHostSyncManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.host-sync.json');
}

function readHostSyncManifest(userId: string): HostSyncManifest {
  try {
    const data = fs.readFileSync(getHostSyncManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { syncedSkills: [], lastSyncAt: '' };
  }
}

function writeHostSyncManifest(
  userId: string,
  manifest: HostSyncManifest,
): void {
  const manifestPath = getHostSyncManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function getSkillsManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.skills-manifest.json');
}

function readSkillsManifest(userId: string): SkillsManifest {
  try {
    const data = fs.readFileSync(getSkillsManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { skills: {} };
  }
}

function writeSkillsManifest(userId: string, manifest: SkillsManifest): void {
  const manifestPath = getSkillsManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Remove a skill from the manifest when it is deleted.
 */
function removeFromSkillsManifest(userId: string, skillId: string): void {
  const manifest = readSkillsManifest(userId);
  if (skillId in manifest.skills) {
    delete manifest.skills[skillId];
    writeSkillsManifest(userId, manifest);
  }
}

function validateSkillId(id: string): boolean {
  return /^[\w\-]+$/.test(id);
}

function validateSkillPath(skillsRoot: string, skillDir: string): boolean {
  try {
    const realSkillsRoot = fs.realpathSync(skillsRoot);
    const realSkillDir = fs.realpathSync(skillDir);
    const relative = path.relative(realSkillsRoot, realSkillDir);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) return {};

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const result: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let multilineMode: 'folded' | 'literal' | null = null;

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([\w\-]+):\s*(.*)$/);
    if (keyMatch) {
      // Save previous key if exists
      if (currentKey) {
        result[currentKey] = currentValue.join(
          multilineMode === 'literal' ? '\n' : ' ',
        );
      }

      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();

      if (value === '>') {
        multilineMode = 'folded';
        currentValue = [];
      } else if (value === '|') {
        multilineMode = 'literal';
        currentValue = [];
      } else {
        result[currentKey] = value;
        currentKey = null;
        currentValue = [];
        multilineMode = null;
      }
    } else if (currentKey && multilineMode) {
      const trimmedLine = line.trimStart();
      if (trimmedLine) {
        currentValue.push(trimmedLine);
      }
    }
  }

  // Save last key
  if (currentKey) {
    result[currentKey] = currentValue.join(
      multilineMode === 'literal' ? '\n' : ' ',
    );
  }

  return result;
}

function listFiles(
  dir: string,
): Array<{ name: string; type: 'file' | 'directory'; size: number }> {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        const stats = fs.statSync(fullPath);
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isDirectory() ? 0 : stats.size,
        };
      });
  } catch {
    return [];
  }
}

function scanDirectory(rootDir: string, source: 'user' | 'project'): Skill[] {
  const skills: Skill[] = [];
  if (!fs.existsSync(rootDir)) return skills;

  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(rootDir, entry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

      let enabled = false;
      let skillFilePath: string | null = null;

      if (fs.existsSync(skillMdPath)) {
        enabled = true;
        skillFilePath = skillMdPath;
      } else if (fs.existsSync(skillMdDisabledPath)) {
        enabled = false;
        skillFilePath = skillMdDisabledPath;
      } else {
        continue;
      }

      try {
        const content = fs.readFileSync(skillFilePath, 'utf-8');
        const frontmatter = parseFrontmatter(content);
        const stats = fs.statSync(skillDir);

        skills.push({
          id: entry.name,
          name: frontmatter.name || entry.name,
          description: frontmatter.description || '',
          source,
          enabled,
          userInvocable:
            frontmatter['user-invocable'] === undefined
              ? true
              : frontmatter['user-invocable'] !== 'false',
          allowedTools: frontmatter['allowed-tools']
            ? frontmatter['allowed-tools'].split(',').map((t) => t.trim())
            : [],
          argumentHint: frontmatter['argument-hint'] || null,
          updatedAt: stats.mtime.toISOString(),
          files: listFiles(skillDir),
        });
      } catch {
        // Skip malformed skills
      }
    }
  } catch {
    // Skip if directory is not readable
  }

  return skills;
}

function discoverSkills(userId: string): Skill[] {
  const userSkills = scanDirectory(getUserSkillsDir(userId), 'user');
  const projectSkills = scanDirectory(getProjectSkillsDir(), 'project');

  // 读取 host sync manifest 标记同步来源
  const hostManifest = readHostSyncManifest(userId);
  const syncedSet = new Set(hostManifest.syncedSkills);

  // 读取 skills manifest 补充安装元数据
  const skillsManifest = readSkillsManifest(userId);

  for (const skill of userSkills) {
    if (syncedSet.has(skill.id)) {
      skill.syncedFromHost = true;
    }
    const meta = skillsManifest.skills[skill.id];
    if (meta) {
      skill.packageName = meta.packageName;
      skill.installedAt = meta.installedAt;
    }
  }

  return [...userSkills, ...projectSkills];
}

function getSkillDetail(skillId: string, userId: string): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const searchDirs: Array<{ rootDir: string; source: 'user' | 'project' }> = [
    { rootDir: getUserSkillsDir(userId), source: 'user' },
    { rootDir: getProjectSkillsDir(), source: 'project' },
  ];

  const hostManifest = readHostSyncManifest(userId);
  const syncedSet = new Set(hostManifest.syncedSkills);
  const skillsManifest = readSkillsManifest(userId);

  for (const { rootDir, source } of searchDirs) {
    const skillDir = path.join(rootDir, skillId);
    if (!fs.existsSync(skillDir)) continue;

    if (!validateSkillPath(rootDir, skillDir)) continue;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

    let enabled = false;
    let skillFilePath: string | null = null;

    if (fs.existsSync(skillMdPath)) {
      enabled = true;
      skillFilePath = skillMdPath;
    } else if (fs.existsSync(skillMdDisabledPath)) {
      enabled = false;
      skillFilePath = skillMdDisabledPath;
    } else {
      continue;
    }

    try {
      const content = fs.readFileSync(skillFilePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const stats = fs.statSync(skillDir);

      const detail: SkillDetail = {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        source,
        enabled,
        userInvocable:
          frontmatter['user-invocable'] === undefined
            ? true
            : frontmatter['user-invocable'] !== 'false',
        allowedTools: frontmatter['allowed-tools']
          ? frontmatter['allowed-tools'].split(',').map((t) => t.trim())
          : [],
        argumentHint: frontmatter['argument-hint'] || null,
        updatedAt: stats.mtime.toISOString(),
        files: listFiles(skillDir),
        content,
      };

      if (source === 'user') {
        if (syncedSet.has(skillId)) {
          detail.syncedFromHost = true;
        }
        const meta = skillsManifest.skills[skillId];
        if (meta) {
          detail.packageName = meta.packageName;
          detail.installedAt = meta.installedAt;
        }
      }

      return detail;
    } catch {
      // Skip malformed skill
    }
  }

  return null;
}

/**
 * Copy a skill entry (directory or symlink target) to dest.
 * Resolves symlinks and copies the real content so the copy is self-contained.
 */
function copySkillToUser(src: string, dest: string): void {
  // Resolve symlink to get the real directory
  let realSrc = src;
  try {
    const lstat = fs.lstatSync(src);
    if (lstat.isSymbolicLink()) {
      realSrc = fs.realpathSync(src);
    }
  } catch {
    // use src as-is
  }

  fs.cpSync(realSrc, dest, { recursive: true });
}

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skills = discoverSkills(authUser.id);
  return c.json({ skills });
});

skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(id, authUser.id);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

// Toggle enable/disable for user-level skills via SKILL.md ↔ SKILL.md.disabled rename.
// Project-level skills are read-only.
skillsRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const { enabled } = await c.req.json<{ enabled: boolean }>();

  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);

  if (!fs.existsSync(skillDir)) {
    return c.json(
      { error: 'Skill not found or is not a user-level skill' },
      404,
    );
  }
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const srcPath = path.join(
    skillDir,
    enabled ? 'SKILL.md.disabled' : 'SKILL.md',
  );
  const dstPath = path.join(
    skillDir,
    enabled ? 'SKILL.md' : 'SKILL.md.disabled',
  );

  if (!fs.existsSync(srcPath)) {
    return c.json(
      { error: 'Skill not found or already in desired state' },
      404,
    );
  }

  fs.renameSync(srcPath, dstPath);
  return c.json({ success: true });
});

/**
 * Delete a user-level skill by ID.
 * Reusable by both the HTTP route and IPC handler.
 */
function deleteSkillForUser(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  const userDir = getUserSkillsDir(userId);
  const skillDir = path.join(userDir, skillId);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'Skill not found or is a project-level skill',
    };
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return { success: false, error: 'Invalid skill path' };
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFromSkillsManifest(userId, skillId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const result = deleteSkillForUser(authUser.id, id);

  if (!result.success) {
    const status =
      result.error === 'Invalid skill ID' ||
      result.error === 'Invalid skill path'
        ? 400
        : result.error?.includes('not found')
          ? 404
          : 500;
    return c.json({ error: result.error }, status);
  }

  return c.json({ success: true });
});

// Sync host-level skills (~/.claude/skills/) to admin's user-level directory.
// Only admin can use this endpoint.
skillsRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host skills' }, 403);
  }

  const hostDir = getGlobalSkillsDir();
  const userDir = getUserSkillsDir(authUser.id);
  fs.mkdirSync(userDir, { recursive: true });

  // 1. 扫描宿主机 skills
  const hostSkillNames: string[] = [];
  if (fs.existsSync(hostDir)) {
    for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(hostDir, entry.name);
      // 验证包含 SKILL.md 或 SKILL.md.disabled
      try {
        const realPath = fs.realpathSync(skillDir);
        if (
          fs.existsSync(path.join(realPath, 'SKILL.md')) ||
          fs.existsSync(path.join(realPath, 'SKILL.md.disabled'))
        ) {
          hostSkillNames.push(entry.name);
        }
      } catch {
        // 跳过 broken symlinks
      }
    }
  }

  // 2. 读取 manifest
  const manifest = readHostSyncManifest(authUser.id);
  const previouslySynced = new Set(manifest.syncedSkills);

  // 3. 检测用户目录中手动安装的 skills
  const existingUserSkills = new Set<string>();
  if (fs.existsSync(userDir)) {
    for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (entry.isDirectory()) existingUserSkills.add(entry.name);
    }
  }

  const stats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
  const newSyncedList: string[] = [];

  // 4. 同步：新增/更新
  for (const name of hostSkillNames) {
    const isManuallyInstalled =
      existingUserSkills.has(name) && !previouslySynced.has(name);
    if (isManuallyInstalled) {
      // 手动安装的 skill，跳过不覆盖
      stats.skipped++;
      continue;
    }

    const src = path.join(hostDir, name);
    const dest = path.join(userDir, name);

    if (existingUserSkills.has(name)) {
      // 已存在且之前是同步来的 → 更新
      fs.rmSync(dest, { recursive: true, force: true });
      copySkillToUser(src, dest);
      stats.updated++;
    } else {
      // 全新的 → 新增
      copySkillToUser(src, dest);
      stats.added++;
    }
    newSyncedList.push(name);
  }

  // 5. 删除宿主机已移除的（仅清理之前同步来的）
  const hostSkillSet = new Set(hostSkillNames);
  for (const name of previouslySynced) {
    if (!hostSkillSet.has(name) && existingUserSkills.has(name)) {
      const dest = path.join(userDir, name);
      fs.rmSync(dest, { recursive: true, force: true });
      stats.deleted++;
    }
  }

  // 6. 更新 manifest
  writeHostSyncManifest(authUser.id, {
    syncedSkills: newSyncedList,
    lastSyncAt: new Date().toISOString(),
  });

  const total = hostSkillNames.length;
  return c.json({ stats, total });
});

// --- Export skills as zip ---
interface ExportSkillRef {
  id: string;
  source: 'user' | 'project';
}

skillsRoutes.post('/export', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const { skills: exportRefs } =
    await c.req.json<{ skills: ExportSkillRef[] }>();

  if (!Array.isArray(exportRefs) || exportRefs.length === 0) {
    return c.json({ error: '请选择至少一个技能' }, 400);
  }

  for (const ref of exportRefs) {
    if (!validateSkillId(ref.id)) {
      return c.json({ error: `无效的技能 ID: ${ref.id}` }, 400);
    }
  }

  // 项目级技能导出也需要 admin 权限（与导入对称）
  const hasProjectRefs = exportRefs.some(ref => ref.source === 'project');
  if (hasProjectRefs && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以导出项目级技能' }, 403);
  }

  const zip = new AdmZip();
  const notFound: string[] = [];

  for (const ref of exportRefs) {
    const rootDir =
      ref.source === 'project'
        ? getProjectSkillsDir()
        : getUserSkillsDir(authUser.id);
    const skillDir = path.join(rootDir, ref.id);

    if (!fs.existsSync(skillDir) || !validateSkillPath(rootDir, skillDir)) {
      notFound.push(ref.id);
      continue;
    }

    // 递归添加技能目录到 zip
    addDirectoryToZip(zip, skillDir, ref.id);
  }

  if (notFound.length === exportRefs.length) {
    return c.json({ error: `未找到任何技能: ${notFound.join(', ')}` }, 404);
  }

  const buffer = zip.toBuffer();
  const filename =
    exportRefs.length === 1 ? `${exportRefs[0].id}.zip` : 'skills-export.zip';

  const stream = Readable.toWeb(
    Readable.from(buffer),
  ) as ReadableStream<Uint8Array>;
  const headers: Record<string, string> = {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': String(buffer.byteLength),
  };
  if (notFound.length > 0) {
    headers['X-Skipped-Skills'] = notFound.join(',');
  }

  return new Response(stream, { headers });
});

/**
 * 递归将目录内容添加到 zip 中（跳过隐藏文件）
 */
function addDirectoryToZip(
  zip: AdmZip,
  dirPath: string,
  zipPrefix: string,
): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, fullPath, zipPath);
    } else {
      zip.addFile(zipPath, fs.readFileSync(fullPath));
    }
  }
}

// --- Import skills from file ---
skillsRoutes.post('/import', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.parseBody();
  const file = body.file;
  const target = (body.target as string) || 'user';

  if (!(file instanceof File)) {
    return c.json({ error: '请上传文件' }, 400);
  }

  if (target === 'project' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以导入项目级技能' }, 403);
  }

  const targetDir =
    target === 'project'
      ? getProjectSkillsDir()
      : getUserSkillsDir(authUser.id);
  fs.mkdirSync(targetDir, { recursive: true });

  const fileName = file.name;
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  // 资源限制：防止 zip bomb
  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
  const MAX_ZIP_ENTRIES = 500;

  if (fileBuffer.byteLength > MAX_UPLOAD_SIZE) {
    return c.json({ error: `文件过大，上限 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` }, 400);
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  if (fileName.endsWith('.md')) {
    // 单个 SKILL.md 文件导入
    const content = fileBuffer.toString('utf-8');
    const frontmatter = parseFrontmatter(content);
    const skillName = frontmatter.name;
    if (!skillName || !validateSkillId(skillName)) {
      return c.json(
        {
          error:
            'SKILL.md 缺少有效的 name 字段（需符合 [\\w\\-]+ 格式）',
        },
        400,
      );
    }

    const skillDir = path.join(targetDir, skillName);
    if (fs.existsSync(skillDir)) {
      skipped.push(skillName);
    } else {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), fileBuffer);
      imported.push(skillName);
    }
  } else if (fileName.endsWith('.zip')) {
    // zip 包导入
    const zip = new AdmZip(fileBuffer);
    const entries = zip.getEntries();

    if (entries.length > MAX_ZIP_ENTRIES) {
      return c.json({ error: `zip 条目过多（${entries.length}），上限 ${MAX_ZIP_ENTRIES}` }, 400);
    }

    // 判断 zip 结构：
    // 1) 根目录直接包含 SKILL.md → 单技能包
    // 2) 子目录各自包含 SKILL.md → 多技能包
    const hasRootSkillMd = entries.some(
      (e) => e.entryName === 'SKILL.md' || e.entryName === './SKILL.md',
    );

    if (hasRootSkillMd) {
      // 单技能 zip：根目录就是技能内容
      const skillMdEntry = entries.find(
        (e) => e.entryName === 'SKILL.md' || e.entryName === './SKILL.md',
      );
      const content = skillMdEntry!.getData().toString('utf-8');
      const frontmatter = parseFrontmatter(content);
      const skillName = frontmatter.name;
      if (!skillName || !validateSkillId(skillName)) {
        return c.json(
          { error: 'zip 中 SKILL.md 缺少有效的 name 字段' },
          400,
        );
      }

      const skillDir = path.join(targetDir, skillName);
      if (fs.existsSync(skillDir)) {
        skipped.push(skillName);
      } else {
        const tmpDir = skillDir + '.importing';
        try {
          extractSkillEntries(zip, entries, '', tmpDir);
          fs.renameSync(tmpDir, skillDir);
          imported.push(skillName);
        } catch (err) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          skipped.push(skillName);
        }
      }
    } else {
      // 多技能 zip：每个顶层子目录是一个技能
      const topDirs = new Set<string>();
      for (const entry of entries) {
        const parts = entry.entryName.split('/').filter(Boolean);
        if (parts.length >= 1) topDirs.add(parts[0]);
      }

      for (const dirName of topDirs) {
        if (!validateSkillId(dirName)) {
          skipped.push(dirName);
          continue;
        }

        // 检查该子目录下是否有 SKILL.md
        const hasSkillMd = entries.some(
          (e) =>
            e.entryName === `${dirName}/SKILL.md` ||
            e.entryName === `${dirName}/SKILL.md.disabled`,
        );
        if (!hasSkillMd) {
          skipped.push(dirName);
          continue;
        }

        const skillDir = path.join(targetDir, dirName);
        if (fs.existsSync(skillDir)) {
          skipped.push(dirName);
          continue;
        }

        const dirEntries = entries.filter((e) =>
          e.entryName.startsWith(`${dirName}/`),
        );
        const tmpDir = skillDir + '.importing';
        try {
          extractSkillEntries(zip, dirEntries, `${dirName}/`, tmpDir);
          fs.renameSync(tmpDir, skillDir);
          imported.push(dirName);
        } catch (err) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          skipped.push(dirName);
        }
      }
    }
  } else {
    return c.json({ error: '仅支持 .md 或 .zip 文件' }, 400);
  }

  return c.json({ imported, skipped });
});

/**
 * 从 zip 中提取技能文件到目标目录
 */
function extractSkillEntries(
  zip: AdmZip,
  entries: AdmZip.IZipEntry[],
  prefix: string,
  destDir: string,
): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    // 去掉前缀得到相对路径
    let relativePath = entry.entryName;
    if (prefix && relativePath.startsWith(prefix)) {
      relativePath = relativePath.slice(prefix.length);
    }
    if (!relativePath || relativePath.startsWith('.')) continue;

    const destPath = path.resolve(destDir, relativePath);
    // 防止路径穿越：resolve 后用 relative 检查是否仍在目标目录内
    const rel = path.relative(destDir, destPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.getData());
  }
}

export { getUserSkillsDir, deleteSkillForUser };
export default skillsRoutes;
