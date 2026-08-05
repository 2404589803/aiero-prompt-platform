import { useEffect, useState } from 'react';
import { Alert, Button, Layout, Menu, Result, Space, Spin, Typography } from 'antd';
import type { Session } from '@supabase/supabase-js';
import { useQuery } from '@tanstack/react-query';
import { supabase } from './lib/supabase';
import { api } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { JobConsolePage } from './pages/JobConsolePage';
import { PromptLibraryPage } from './pages/PromptLibraryPage';
import { AppsPage } from './pages/AppsPage';
import { AccountPoolPage } from './pages/AccountPoolPage';
import { JailbreakPromptPage } from './pages/JailbreakPromptPage';
import { ModelListPage } from './pages/ModelListPage';

type ViewKey = 'jobs' | 'prompts' | 'apps' | 'accounts' | 'jailbreak' | 'models';

const VIEW_LABEL: Record<ViewKey, string> = {
  jobs: '抓取任务',
  prompts: '提示词库',
  apps: '角色卡',
  accounts: '账号池',
  jailbreak: '越狱提示词',
  models: '可用模型',
};

// 抓取配置单独分组：账号和越狱提示词是「设置好就不常动」的东西，
// 跟每天要看的任务、提示词库混在一列里容易点错。
const MENU_ITEMS = [
  { key: 'jobs', label: VIEW_LABEL.jobs },
  { key: 'prompts', label: VIEW_LABEL.prompts },
  { key: 'apps', label: VIEW_LABEL.apps },
  {
    key: 'config',
    label: '抓取配置',
    type: 'group' as const,
    children: [
      { key: 'accounts', label: VIEW_LABEL.accounts },
      { key: 'jailbreak', label: VIEW_LABEL.jailbreak },
      { key: 'models', label: VIEW_LABEL.models },
    ],
  },
];

export function AieroApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<ViewKey>('jobs');

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // 登录成功不等于有权限：还要在运营平台的管理员名单里，这一步由后端判定。
  const me = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: Boolean(session),
    retry: false,
  });

  if (!ready) {
    return (
      <div className="login-shell">
        <Spin size="large" />
      </div>
    );
  }

  if (!session) return <LoginPage />;

  if (me.isError) {
    return (
      <div className="login-shell">
        <Result
          status="403"
          title="无法进入平台"
          subTitle={me.error instanceof Error ? me.error.message : '权限校验失败'}
          extra={<Button onClick={() => void supabase.auth.signOut()}>退出登录</Button>}
        />
      </div>
    );
  }

  return (
    <Layout className="app-layout">
      <Layout.Sider width={220} theme="light" className="app-sider">
        <div className="app-brand">
          <strong>提示词抓取平台</strong>
          <small>AI风月角色卡 · 测试库</small>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[view]}
          onClick={({ key }) => setView(key as ViewKey)}
          items={MENU_ITEMS}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header className="app-header">
          <Typography.Text strong>{VIEW_LABEL[view]}</Typography.Text>
          <Space>
            <Typography.Text type="secondary">
              {me.data?.displayName ?? me.data?.email ?? session.user.email}
            </Typography.Text>
            <Button size="small" onClick={() => void supabase.auth.signOut()}>
              退出
            </Button>
          </Space>
        </Layout.Header>

        <Layout.Content className="app-content">
          {me.isLoading ? (
            <Spin />
          ) : (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Alert
                type="warning"
                showIcon
                banner
                message="本平台读写的是测试库，抓取动作会用真实账号访问风月并触发其限流。"
              />
              {view === 'jobs' ? <JobConsolePage /> : null}
              {view === 'prompts' ? <PromptLibraryPage /> : null}
              {view === 'apps' ? <AppsPage /> : null}
              {view === 'accounts' ? <AccountPoolPage /> : null}
              {view === 'jailbreak' ? <JailbreakPromptPage /> : null}
              {view === 'models' ? <ModelListPage /> : null}
            </Space>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
