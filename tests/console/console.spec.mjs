import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const routes = [
  ['overview', /控制面总览/],
  ['observability', /Observability/],
  ['inbox', /Inbox/],
  ['tickets', /Tickets/],
  ['outbox', /Outbox/],
  ['policy', /Policy/],
  ['automations', /Automations/],
  ['sources', /Sources/],
  ['workers', /Workers/],
  ['projects', /Projects/],
  ['glossary', /Glossary/],
];

test.describe('self-loop console', () => {
  let pageErrors;
  let consoleErrors;

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
  });

  test.afterEach(() => {
    expect(pageErrors, 'uncaught page errors').toEqual([]);
    expect(consoleErrors, 'browser console errors').toEqual([]);
  });

  for (const [route, heading] of routes) {
    test(`${route} renders and has no WCAG A/AA violations`, async ({ page }) => {
      await page.goto(`/#/${route}`);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('h1')).toContainText(heading);
      await page.waitForTimeout(200);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
    });
  }

  test('theme switching persists across reloads', async ({ page }) => {
    await page.goto('/#/overview');
    const theme = page.locator('[data-theme-select]');
    await theme.selectOption('ocean');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ocean');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ocean');
    await expect(theme).toHaveValue('ocean');
  });

  test('project directory picker fills and submits an absolute path', async ({ page }) => {
    const work = '/tmp/self-loop-e2e';
    await page.route('**/api/fs/roots', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        roots: [{ path: work, label: 'Working directory · 当前目录', kind: 'cwd' }],
        separator: '/',
      }),
    }));
    await page.route(/\/api\/fs\/dirs/, async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path') || work;
      const body = target.endsWith('/repo-a')
        ? {
            path: target,
            parent: work,
            breadcrumbs: [
              { label: '/', path: '/' },
              { label: 'self-loop-e2e', path: work },
              { label: 'repo-a', path: target },
            ],
            entries: [],
            truncated: false,
            limit: 400,
          }
        : {
            path: work,
            parent: '/tmp',
            breadcrumbs: [
              { label: '/', path: '/' },
              { label: 'tmp', path: '/tmp' },
              { label: 'self-loop-e2e', path: work },
            ],
            entries: [
              { name: 'repo-a', path: `${work}/repo-a`, hidden: false },
              { name: '.git', path: `${work}/.git`, hidden: true },
            ],
            truncated: false,
            limit: 400,
          };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    let posted = null;
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posted = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, project: { id: 'prj_e2e' } }),
      });
    });

    await page.goto('/#/projects');
    await page.getByRole('button', { name: /添加项目/ }).click();
    await page.getByRole('button', { name: /浏览/ }).click();
    await expect(page.getByRole('button', { name: /repo-a/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /\.git/ })).toHaveCount(0);

    await page.getByRole('button', { name: /repo-a/ }).click();
    await expect(page.locator('#dir-picker')).toContainText('repo-a');
    await page.getByRole('button', { name: /选择此目录/ }).click();
    await expect(page.locator('#prj-path')).toHaveValue(`${work}/repo-a`);

    await page.getByRole('button', { name: /注册并切换/ }).click();
    await expect.poll(() => posted?.path).toBe(`${work}/repo-a`);
  });

  test('project switching changes the active repository', async ({ page }) => {
    await page.goto('/#/projects');
    await expect(page.locator('.project-card')).toHaveCount(2);
    const currentBefore = await page.locator('[data-project-select]').inputValue();
    const switchButton = page.getByRole('button', { name: /切换/ }).first();
    await switchButton.click();
    await expect(page).toHaveURL(/#\/overview/);
    const currentAfter = await page.locator('[data-project-select]').inputValue();
    expect(currentAfter).not.toBe(currentBefore);
  });

  test('audit filters reduce the visible rows', async ({ page }) => {
    await page.goto('/#/policy');
    const summary = page.locator('.card-header', { hasText: '审计日志' }).locator('.badge');
    const before = await summary.textContent();
    await page.getByLabel('搜索审计记录').fill('definitely-no-match');
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(summary).toContainText('/');
    const after = await summary.textContent();
    expect(after).not.toBe(before);
    await expect(page.getByText('没有匹配的审计记录')).toBeVisible();
  });

  test('English terms keep Chinese explanations', async ({ page }) => {
    await page.goto('/#/glossary');
    const entry = page.locator('.glossary-item').filter({ hasText: 'Observability' });
    await expect(entry).toBeVisible();
    await expect(entry.getByText('可观测性')).toBeVisible();
    await expect(page.getByText('把队列、失败、Worker 和连接器健康集中到一页。')).toBeVisible();
  });
});
