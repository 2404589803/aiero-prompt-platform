import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScraperAccount } from '@aiero/shared';
import { api } from '../lib/api';

interface AccountFormValues {
  email: string;
  password?: string;
  note?: string;
}

export function AccountPoolPage() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<AccountFormValues>();
  const [editing, setEditing] = useState<ScraperAccount | null>(null);
  const [open, setOpen] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['accounts'] });

  const save = useMutation({
    mutationFn: async (values: AccountFormValues) => {
      const note = values.note?.trim() ? values.note.trim() : null;
      if (editing) {
        return api.updateAccount(editing.id, {
          email: values.email.trim(),
          // 留空即不改密码，接口按缺省处理。
          ...(values.password?.trim() ? { password: values.password.trim() } : {}),
          note,
        });
      }
      return api.createAccount({
        email: values.email.trim(),
        password: values.password?.trim() ?? '',
        note,
      });
    },
    onSuccess: () => {
      message.success(editing ? '已保存' : '账号已加入池子');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.updateAccount(input.id, { enabled: input.enabled }),
    onSuccess: (account) => {
      message.success(account.enabled ? '已启用' : '已停用');
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAccount(id),
    onSuccess: () => {
      message.success('已删除');
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const check = useMutation({
    mutationFn: (id: string) => api.checkAccount(id),
    onSuccess: ({ result }) => {
      if (result.ok) message.success('登录成功，账号可用');
      else message.error(`登录失败：${result.message}`);
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
    onSettled: () => setCheckingId(null),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (account: ScraperAccount) => {
    setEditing(account);
    form.setFieldsValue({ email: account.email, password: '', note: account.note ?? '' });
    setOpen(true);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="账号池以数据库为准，改完下次启动任务生效"
        description="正在运行的任务在启动那一刻就把账号取好了，中途增删不会影响它。抽取全靠这些站点账号，账号失效不会让任务报错，只会让它领到的每张卡都抽失败——加完账号请点一次「体检」。"
      />

      {accounts.data?.encryptionEnabled === false ? (
        <Alert
          type="warning"
          showIcon
          message="站点密码正在以明文存库"
          description="后端没有配置 ACCOUNT_SECRET_KEY，密码明文写在数据库里。配上这个环境变量后新录入和修改的密码会自动加密，已有的明文行需要重新录入一次密码才会转成密文。"
        />
      ) : accounts.data?.hasPlaintext ? (
        <Alert
          type="warning"
          showIcon
          message="有账号的密码还是明文"
          description="加密密钥已配置，但这些账号是在配置之前录入的。对它们重新输入一次密码即可转成密文。"
        />
      ) : null}

      <Card
        title="站点账号池"
        extra={
          <Button type="primary" onClick={openCreate}>
            添加账号
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={accounts.isLoading}
          dataSource={accounts.data?.items ?? []}
          pagination={false}
          columns={[
            { title: '账号', dataIndex: 'email' },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 90,
              render: (enabled: boolean, row: ScraperAccount) => (
                <Switch
                  size="small"
                  checked={enabled}
                  loading={toggle.isPending && toggle.variables?.id === row.id}
                  onChange={(next) => toggle.mutate({ id: row.id, enabled: next })}
                />
              ),
            },
            {
              title: '密码存储',
              dataIndex: 'passwordEncrypted',
              width: 110,
              render: (encrypted: boolean) =>
                encrypted ? <Tag color="green">已加密</Tag> : <Tag color="orange">明文</Tag>,
            },
            {
              title: '体检结果',
              width: 220,
              render: (_, row: ScraperAccount) => {
                if (row.lastLoginOk === null)
                  return <Typography.Text type="secondary">未体检</Typography.Text>;
                if (row.lastLoginOk) {
                  return (
                    <Space size={4}>
                      <Tag color="green">可用</Tag>
                      <Typography.Text type="secondary">
                        {row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString('zh-CN') : ''}
                      </Typography.Text>
                    </Space>
                  );
                }
                return (
                  <Space size={4}>
                    <Tag color="red">失效</Tag>
                    <Typography.Text type="danger" ellipsis style={{ maxWidth: 140 }}>
                      {row.lastError ?? ''}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: '备注',
              dataIndex: 'note',
              ellipsis: true,
              render: (note: string | null) => note ?? '—',
            },
            {
              title: '操作',
              width: 200,
              render: (_, row: ScraperAccount) => (
                <Space size={4}>
                  <Button
                    size="small"
                    loading={checkingId === row.id}
                    onClick={() => {
                      setCheckingId(row.id);
                      check.mutate(row.id);
                    }}
                  >
                    体检
                  </Button>
                  <Button size="small" type="link" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除这个账号？"
                    description="删除后不影响已抽取的结果。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => remove.mutate(row.id)}
                  >
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑账号 ${editing.email}` : '添加账号'}
        okText="保存"
        cancelText="取消"
        confirmLoading={save.isPending}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        onOk={() => void form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item
            name="email"
            label="站点账号"
            rules={[{ required: true, message: '填写站点登录用的账号' }]}
          >
            <Input placeholder="站点登录名或邮箱" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            extra={editing ? '留空表示不修改密码' : undefined}
            rules={editing ? [] : [{ required: true, message: '填写密码' }]}
          >
            <Input.Password
              placeholder={editing ? '留空则保持原密码' : '站点登录密码'}
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="比如这个账号的来源、额度情况" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
