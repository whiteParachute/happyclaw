import { useEffect, useState, useMemo, useRef } from 'react';
import { RefreshCw, Puzzle, Download, Upload, CheckSquare, Square } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSkillsStore } from '../stores/skills';
import { useAuthStore } from '../stores/auth';
import { SkillCard } from '../components/skills/SkillCard';
import { SkillDetail } from '../components/skills/SkillDetail';

export function SkillsPage() {
  const {
    skills,
    loading,
    error,
    loadSkills,
    exportSkills,
    importSkills,
  } = useSkillsStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // 多选模式：key = "id:source" 用于唯一标识，value = { id, source }
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMap, setSelectedMap] = useState<Map<string, { id: string; source: 'user' | 'project' }>>(new Map());
  const [exporting, setExporting] = useState(false);

  // 导入对话框
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<'user' | 'project'>('user');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: string[]; skipped: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }, [skills, searchQuery]);

  const manualUserSkills = filtered.filter((s) => s.source === 'user' && !s.syncedFromHost);
  const syncedUserSkills = filtered.filter((s) => s.source === 'user' && s.syncedFromHost);
  const projectSkills = filtered.filter((s) => s.source === 'project');

  const enabledCount = skills.filter((s) => s.enabled).length;

  const skillKey = (id: string, source: 'user' | 'project') => `${id}:${source}`;

  const toggleSelect = (id: string, source: 'user' | 'project') => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      const key = skillKey(id, source);
      if (next.has(key)) next.delete(key);
      else next.set(key, { id, source });
      return next;
    });
  };

  const handleExport = async () => {
    if (selectedMap.size === 0) return;
    setExporting(true);
    try {
      await exportSkills(Array.from(selectedMap.values()));
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedMap(new Map());
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    try {
      const result = await importSkills(importFile, importTarget);
      setImportResult(result);
      if (result.imported.length > 0 && result.skipped.length === 0) {
        setTimeout(() => {
          setImportOpen(false);
          resetImportState();
        }, 1500);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const resetImportState = () => {
    setImportFile(null);
    setImportResult(null);
    setImportTarget('user');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const selectAllFiltered = () => {
    const next = new Map<string, { id: string; source: 'user' | 'project' }>();
    for (const s of filtered) next.set(skillKey(s.id, s.source), { id: s.id, source: s.source });
    setSelectedMap(next);
  };

  const deselectAll = () => {
    setSelectedMap(new Map());
  };

  const renderSkillList = (
    title: string,
    skillList: typeof filtered,
  ) => {
    if (skillList.length === 0) return null;
    return (
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3">
          {title} ({skillList.length})
        </h2>
        <div className="space-y-2">
          {skillList.map((skill) => (
            <div key={skillKey(skill.id, skill.source)} className="flex items-start gap-2">
              {selectMode && (
                <button
                  className="mt-4 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelect(skill.id, skill.source);
                  }}
                >
                  {selectedMap.has(skillKey(skill.id, skill.source)) ? (
                    <CheckSquare size={18} className="text-primary" />
                  ) : (
                    <Square size={18} />
                  )}
                </button>
              )}
              <div className="flex-1 min-w-0">
                <SkillCard
                  skill={skill}
                  selected={selectedId === skill.id}
                  onSelect={() => {
                    if (selectMode) {
                      toggleSelect(skill.id, skill.source);
                    } else {
                      setSelectedId(skill.id);
                    }
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="技能管理"
            subtitle={`用户级 ${manualUserSkills.length + syncedUserSkills.length}${syncedUserSkills.length > 0 ? `（含同步 ${syncedUserSkills.length}）` : ''} · 项目级 ${projectSkills.length} · 启用 ${enabledCount}`}
            actions={
              <div className="flex items-center gap-2">
                {selectMode ? (
                  <>
                    <span className="text-sm text-muted-foreground">
                      已选 {selectedMap.size} 项
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={selectedMap.size === filtered.length ? deselectAll : selectAllFiltered}
                    >
                      {selectedMap.size === filtered.length ? '取消全选' : '全选'}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleExport}
                      disabled={selectedMap.size === 0 || exporting}
                    >
                      <Download size={16} />
                      {exporting ? '导出中...' : '导出'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={exitSelectMode}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectMode(true)}
                      disabled={skills.length === 0}
                    >
                      <CheckSquare size={16} />
                      多选导出
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        resetImportState();
                        setImportOpen(true);
                      }}
                    >
                      <Upload size={16} />
                      导入
                    </Button>
                    <Button variant="outline" size="sm" onClick={loadSkills} disabled={loading}>
                      <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                      刷新
                    </Button>
                  </>
                )}
              </div>
            }
          />
        </div>

        {/* Content */}
        <div className="flex gap-6 p-4">
          {/* 左侧列表 */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索技能名称或描述"
              />
            </div>

            <div className="space-y-6">
              {loading && skills.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <div className="bg-card rounded-xl border border-red-200 p-6 text-center">
                  <p className="text-red-600">{error}</p>
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Puzzle}
                  title={searchQuery ? '没有找到匹配的技能' : '暂无技能'}
                />
              ) : (
                <>
                  {renderSkillList('用户级技能', manualUserSkills)}
                  {renderSkillList('宿主机同步', syncedUserSkills)}
                  {renderSkillList('项目级技能', projectSkills)}
                </>
              )}
            </div>
          </div>

          {/* 右侧详情（桌面端） */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            <SkillDetail skillId={selectedId} onDeleted={() => setSelectedId(null)} />
          </div>
        </div>

        {/* 移动端详情 */}
        {selectedId && !selectMode && (
          <div className="lg:hidden p-4">
            <SkillDetail skillId={selectedId} onDeleted={() => setSelectedId(null)} />
          </div>
        )}
      </div>

      {/* 导入对话框 */}
      <Dialog open={importOpen} onOpenChange={(open) => { setImportOpen(open); if (!open) resetImportState(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导入技能</DialogTitle>
            <DialogDescription>
              支持单个 SKILL.md 文件、单技能 zip 包、多技能 zip 包
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* 目标级别选择 */}
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                导入级别
              </label>
              <Select value={importTarget} onValueChange={(v) => setImportTarget(v as 'user' | 'project')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">用户级</SelectItem>
                  {isAdmin && <SelectItem value="project">项目级（仅管理员）</SelectItem>}
                </SelectContent>
              </Select>
            </div>

            {/* 文件选择 */}
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                选择文件
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.zip"
                onChange={(e) => {
                  setImportFile(e.target.files?.[0] ?? null);
                  setImportResult(null);
                }}
                className="block w-full text-sm text-muted-foreground
                  file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0
                  file:text-sm file:font-semibold file:bg-primary file:text-primary-foreground
                  hover:file:bg-primary/90 file:cursor-pointer"
              />
              {importFile && (
                <p className="text-xs text-muted-foreground mt-1">
                  {importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>

            {/* 导入结果 */}
            {importResult && (
              <div className="rounded-md border p-3 text-sm space-y-1">
                {importResult.imported.length > 0 && (
                  <p className="text-green-600">
                    成功导入：{importResult.imported.join(', ')}
                  </p>
                )}
                {importResult.skipped.length > 0 && (
                  <p className="text-amber-600">
                    已跳过（已存在或无效）：{importResult.skipped.join(', ')}
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setImportOpen(false); resetImportState(); }}
            >
              {importResult ? '关闭' : '取消'}
            </Button>
            {!importResult && (
              <Button
                onClick={handleImport}
                disabled={!importFile || importing}
              >
                {importing ? '导入中...' : '导入'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
