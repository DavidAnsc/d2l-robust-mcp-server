import { describe, it, expect } from 'vitest';
import { classifyTopic, findModulesByTitle, mapLimit, walkToc } from '../../src/content-tree.js';

describe('classifyTopic', () => {
  const t = (Url?: string, extra: Record<string, unknown> = {}) => ({ TopicId: 1, Title: 'x', Url, ...extra });
  it.each([
    ['/content/enforced/1-X/lec.pptx', 'file'],
    ['/content/enforced/1-X/page.html', 'page'],
    ['/content/enforced/1-X/clip.mp4', 'video'],
    ['/d2l/lms/dropbox/user/folder_submit_files.d2l?db=5', 'assignment'],
    ['/d2l/lms/quizzing/user/quiz_summary.d2l?qi=5', 'quiz'],
    ['/d2l/le/1/discussions/topics/3/View', 'discussion'],
    ['/d2l/le/lti/1/launch/2', 'external_tool'],
    ['https://www.youtube.com/watch?v=abc', 'video'],
    ['https://publisher.example/book', 'link'],
  ])('%s → %s', (url, kind) => {
    expect(classifyTopic(t(url))).toBe(kind);
  });

  it('falls back to the activity type', () => {
    expect(classifyTopic(t(undefined, { ActivityType: 21 }))).toBe('scorm');
    expect(classifyTopic(t('/d2l/common/x', { ActivityType: 4 }))).toBe('quiz');
  });
});

describe('findModulesByTitle', () => {
  const toc = [
    { ModuleId: 1, Title: 'Week 1', Modules: [{ ModuleId: 2, Title: 'Week 1 - Lab' }] },
    { ModuleId: 3, Title: 'Week 10' },
  ];
  it('prefers an exact title', () => {
    expect(findModulesByTitle(toc, 'week 1').map((f) => f.module.ModuleId)).toEqual([1]);
  });
  it('matches whole words only', () => {
    expect(findModulesByTitle(toc, 'Lab').map((f) => f.module.ModuleId)).toEqual([2]);
    expect(findModulesByTitle(toc, 'Week').map((f) => f.module.ModuleId)).toEqual([1, 2, 3]);
  });
});

describe('walkToc', () => {
  it('gives each topic its module path, in course order', () => {
    const flat = walkToc([{ ModuleId: 1, Title: 'A', Topics: [{ TopicId: 1, Title: 't1' }], Modules: [{ ModuleId: 2, Title: 'B', Topics: [{ TopicId: 2, Title: 't2' }] }] }]);
    expect(flat.map((f) => [f.topic.TopicId, f.path.join('/')])).toEqual([[1, 'A'], [2, 'A/B']]);
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
