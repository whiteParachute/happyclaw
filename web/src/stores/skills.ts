import { create } from 'zustand';
import { api, apiFetch } from '../api/client';
import { withBasePath } from '../utils/url';

export interface Skill {
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

export interface SkillDetail extends Skill {
  content: string;
}

interface SkillsState {
  skills: Skill[];
  loading: boolean;
  error: string | null;

  loadSkills: () => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  getSkillDetail: (id: string) => Promise<SkillDetail>;
  exportSkills: (skills: Array<{ id: string; source: 'user' | 'project' }>) => Promise<void>;
  importSkills: (file: File, target: 'user' | 'project') => Promise<{ imported: string[]; skipped: string[] }>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  loading: false,
  error: null,

  loadSkills: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ skills: Skill[] }>('/api/skills');
      set({ skills: data.skills, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleSkill: async (id: string, enabled: boolean) => {
    try {
      await api.patch(`/api/skills/${id}`, { enabled });
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteSkill: async (id: string) => {
    try {
      await api.delete(`/api/skills/${id}`);
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  getSkillDetail: async (id: string) => {
    const data = await api.get<{ skill: SkillDetail }>(`/api/skills/${id}`);
    return data.skill;
  },

  exportSkills: async (skills: Array<{ id: string; source: 'user' | 'project' }>) => {
    const res = await fetch(withBasePath('/api/skills/export'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || '导出失败');
    }
    const blob = await res.blob();
    const filename = skills.length === 1 ? `${skills[0].id}.zip` : 'skills-export.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  importSkills: async (file: File, target: 'user' | 'project') => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('target', target);
    const result = await apiFetch<{ imported: string[]; skipped: string[] }>(
      '/api/skills/import',
      { method: 'POST', body: formData, headers: {} },
    );
    await get().loadSkills();
    return result;
  },
}));
