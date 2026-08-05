import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { supabase } from '../lib/supabase';

export function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword(values);
    if (signInError) setError(signInError.message);
    setLoading(false);
  };

  return (
    <div className="login-shell">
      <Card className="login-card">
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          提示词抓取平台
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
          使用运营平台的管理员账号登录。
        </Typography.Paragraph>

        {error ? (
          <Alert type="error" message={error} style={{ marginBottom: 16 }} showIcon />
        ) : null}

        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '请输入邮箱' }]}>
            <Input autoComplete="username" placeholder="you@example.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
