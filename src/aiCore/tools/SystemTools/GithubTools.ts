import { tool } from 'ai'
import { Buffer } from 'buffer'
import { z } from 'zod'

/**
 * GitHub REST API 工具组（BYOK）。
 *
 * 手机沙盒跑不了 gh CLI（需要二进制/子进程），但 GitHub 提供 HTTP API。
 * 用户提供 Personal Access Token（https://github.com/settings/tokens，
 * 至少勾选 repo 权限），agent 用 `Authorization: Bearer <PAT>` 调接口。
 */

const GH_BASE = 'https://api.github.com'

async function ghGet(path: string, token: string): Promise<any> {
  const resp = await fetch(`${GH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 200)}`)
  }
  return resp.json()
}

async function ghPost(path: string, token: string, body: any): Promise<any> {
  const resp = await fetch(`${GH_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 200)}`)
  }
  return resp.json()
}

export const ghGetUser = tool({
  description: '获取当前 GitHub 账号信息（登录名、名字、公开仓库数、粉丝等）。需要用户提供 GitHub Personal Access Token。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token')
  }),
  execute: async ({ token }) => {
    const u = await ghGet('/user', token)
    return {
      ok: true,
      login: u.login,
      name: u.name,
      bio: u.bio,
      publicRepos: u.public_repos,
      followers: u.followers,
      following: u.following,
      htmlUrl: u.html_url
    }
  }
})

export const ghListRepos = tool({
  description: '列出当前用户可见的仓库（可按关键词过滤、排序）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    query: z.string().optional().describe('仓库名关键词过滤'),
    sort: z.enum(['full_name', 'created', 'updated', 'pushed']).optional().default('updated').describe('排序字段'),
    perPage: z.number().optional().default(20).describe('每页数量')
  }),
  execute: async ({ token, query, sort, perPage }) => {
    const params = new URLSearchParams({ sort: sort ?? 'updated', per_page: String(perPage ?? 20) })
    const repos = await ghGet(`/user/repos?${params}`, token)
    const filtered = query ? repos.filter((r: any) => (r.full_name ?? '').toLowerCase().includes(query.toLowerCase())) : repos
    return {
      ok: true,
      repos: filtered.map((r: any) => ({
        fullName: r.full_name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        forks: r.forks_count,
        updatedAt: r.updated_at,
        private: r.private,
        htmlUrl: r.html_url
      }))
    }
  }
})

export const ghGetRepo = tool({
  description: '获取单个仓库的详细信息（描述、语言、星标、默认分支、最近提交时间等）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    owner: z.string().describe('仓库所有者'),
    repo: z.string().describe('仓库名')
  }),
  execute: async ({ token, owner, repo }) => {
    const r = await ghGet(`/repos/${owner}/${repo}`, token)
    return {
      ok: true,
      fullName: r.full_name,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      openIssues: r.open_issues_count,
      defaultBranch: r.default_branch,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      license: r.license?.spdx_id,
      htmlUrl: r.html_url
    }
  }
})

export const ghCreateRepo = tool({
  description: '创建一个新仓库。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    name: z.string().describe('仓库名'),
    description: z.string().optional().describe('仓库描述'),
    private: z.boolean().optional().default(false).describe('是否私有'),
    autoInit: z.boolean().optional().default(true).describe('是否自动初始化 README')
  }),
  execute: async ({ token, name, description, private: isPrivate, autoInit }) => {
    const r = await ghPost('/user/repos', token, {
      name,
      description,
      private: isPrivate ?? false,
      auto_init: autoInit ?? true
    })
    return { ok: true, fullName: r.full_name, htmlUrl: r.html_url }
  }
})

export const ghListIssues = tool({
  description: '列出仓库的 issue（可按状态/作者/标签筛选）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    owner: z.string().describe('仓库所有者'),
    repo: z.string().describe('仓库名'),
    state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('issue 状态'),
    perPage: z.number().optional().default(20).describe('每页数量')
  }),
  execute: async ({ token, owner, repo, state, perPage }) => {
    const issues = await ghGet(`/repos/${owner}/${repo}/issues?state=${state ?? 'open'}&per_page=${perPage ?? 20}`, token)
    return {
      ok: true,
      issues: issues
        .filter((i: any) => !i.pull_request) // 排除 PR
        .map((i: any) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: (i.labels ?? []).map((l: any) => l.name),
          user: i.user?.login,
          comments: i.comments,
          createdAt: i.created_at,
          htmlUrl: i.html_url
        }))
    }
  }
})

export const ghCreateIssue = tool({
  description: '在仓库创建一个 issue。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    owner: z.string().describe('仓库所有者'),
    repo: z.string().describe('仓库名'),
    title: z.string().describe('issue 标题'),
    body: z.string().optional().describe('issue 正文（支持 Markdown）'),
    labels: z.array(z.string()).optional().describe('标签列表')
  }),
  execute: async ({ token, owner, repo, title, body, labels }) => {
    const issue = await ghPost(`/repos/${owner}/${repo}/issues`, token, { title, body, labels })
    return { ok: true, number: issue.number, title: issue.title, htmlUrl: issue.html_url }
  }
})

export const ghCreateComment = tool({
  description: '在 issue 或 PR 上创建一条评论。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    owner: z.string().describe('仓库所有者'),
    repo: z.string().describe('仓库名'),
    issueNumber: z.number().describe('issue 或 PR 编号'),
    body: z.string().describe('评论内容（支持 Markdown）')
  }),
  execute: async ({ token, owner, repo, issueNumber, body }) => {
    const comment = await ghPost(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, { body })
    return { ok: true, commentId: comment.id, htmlUrl: comment.html_url }
  }
})

export const ghListPullRequests = tool({
  description: '列出仓库的 Pull Request（可按状态筛选）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    owner: z.string().describe('仓库所有者'),
    repo: z.string().describe('仓库名'),
    state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('PR 状态'),
    perPage: z.number().optional().default(20).describe('每页数量')
  }),
  execute: async ({ token, owner, repo, state, perPage }) => {
    const prs = await ghGet(`/repos/${owner}/${repo}/pulls?state=${state ?? 'open'}&per_page=${perPage ?? 20}`, token)
    return {
      ok: true,
      pullRequests: prs.map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        user: p.user?.login,
        merged: p.merged,
        head: p.head?.label,
        base: p.base?.label,
        htmlUrl: p.html_url
      }))
    }
  }
})

export const ghCreatePullRequest = tool({
  description: '创建一条 Pull Request。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    owner: z.string().describe('仓库所有者'),
    repo: z.string().describe('仓库名'),
    title: z.string().describe('PR 标题'),
    head: z.string().describe('源分支'),
    base: z.string().describe('目标分支'),
    body: z.string().optional().describe('PR 描述')
  }),
  execute: async ({ token, owner, repo, title, head, base, body }) => {
    const pr = await ghPost(`/repos/${owner}/${repo}/pulls`, token, { title, head, base, body })
    return { ok: true, number: pr.number, title: pr.title, htmlUrl: pr.html_url }
  }
})

export const ghCreateGist = tool({
  description: '创建一条 GitHub Gist（代码片段/笔记）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    description: z.string().optional().describe('Gist 描述'),
    files: z
      .record(z.string(), z.object({ content: z.string() }))
      .describe('文件名到内容的映射，如 {"hello.py": {"content": "print(1)"}}'),
    public: z.boolean().optional().default(false).describe('是否公开')
  }),
  execute: async ({ token, description, files, public: isPublic }) => {
    const gist = await ghPost('/gists', token, { description, files, public: isPublic ?? false })
    return {
      ok: true,
      id: gist.id,
      htmlUrl: gist.html_url,
      files: Object.keys(gist.files ?? {}).map((name: string) => ({ name, size: gist.files[name].size }))
    }
  }
})

export const ghSearchRepos = tool({
  description: '搜索 GitHub 公开仓库（按关键词，可按语言/星标数排序）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    query: z.string().describe('搜索关键词'),
    language: z.string().optional().describe('语言过滤，如 javascript'),
    sort: z.enum(['stars', 'forks', 'updated']).optional().default('stars').describe('排序'),
    perPage: z.number().optional().default(10).describe('每页数量')
  }),
  execute: async ({ token, query, language, sort, perPage }) => {
    let q = query
    if (language) q += ` language:${language}`
    const params = new URLSearchParams({ q, sort: sort ?? 'stars', per_page: String(perPage ?? 10) })
    const data = await ghGet(`/search/repositories?${params}`, token)
    return {
      ok: true,
      totalCount: data.total_count,
      repos: data.items.map((r: any) => ({
        fullName: r.full_name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        htmlUrl: r.html_url
      }))
    }
  }
})

export const ghReadFile = tool({
  description: '读取仓库某个文件的原始内容（需要知道默认分支）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    owner: z.string().describe('仓库所有者'),
    repo: z.string().describe('仓库名'),
    path: z.string().describe('文件路径，如 README.md'),
    branch: z.string().optional().describe('分支名，默认仓库默认分支')
  }),
  execute: async ({ token, owner, repo, path, branch }) => {
    const suffix = branch ? `?ref=${encodeURIComponent(branch)}` : ''
    const data = await ghGet(`/repos/${owner}/${repo}/contents/${path}${suffix}`, token)
    if (data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf-8')
      return { ok: true, path: data.path, size: data.size, content }
    }
    return { ok: true, path: data.path, type: 'directory', entries: (data ?? []).map((e: any) => e.name) }
  }
})

export const ghListIssuesAssigned = tool({
  description: '列出分配给当前用户的 issue（跨仓库，相当于 GitHub 的 Assigned 视图）。',
  inputSchema: z.object({
    token: z.string().describe('GitHub Personal Access Token'),
    filter: z.enum(['assigned', 'created', 'mentioned', 'subscribed']).optional().default('assigned').describe('过滤维度'),
    state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('issue 状态'),
    perPage: z.number().optional().default(20).describe('每页数量')
  }),
  execute: async ({ token, filter, state, perPage }) => {
    const params = new URLSearchParams({ filter: filter ?? 'assigned', state: state ?? 'open', per_page: String(perPage ?? 20) })
    const issues = await ghGet(`/issues?${params}`, token)
    return {
      ok: true,
      issues: issues.map((i: any) => ({
        number: i.number,
        title: i.title,
        repo: i.repository?.full_name,
        state: i.state,
        labels: (i.labels ?? []).map((l: any) => l.name),
        createdAt: i.created_at,
        htmlUrl: i.html_url
      }))
    }
  }
})

export const GithubTool = {
  GetUser: ghGetUser,
  ListRepos: ghListRepos,
  GetRepo: ghGetRepo,
  CreateRepo: ghCreateRepo,
  ListIssues: ghListIssues,
  CreateIssue: ghCreateIssue,
  CreateComment: ghCreateComment,
  ListPullRequests: ghListPullRequests,
  CreatePullRequest: ghCreatePullRequest,
  CreateGist: ghCreateGist,
  SearchRepos: ghSearchRepos,
  ReadFile: ghReadFile,
  ListAssignedIssues: ghListIssuesAssigned
}

export type GithubToolKeys = keyof typeof GithubTool
