import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { JAILBREAK_CONTENT_MAX, JAILBREAK_NAME_MAX, type JailbreakPrompt } from '@aiero/shared';
import { api } from '../lib/api';

interface PromptFormValues {
  name: string;
  content: string;
  sortOrder: number;
  enabled: boolean;
}

/** 成功率只在有过尝试时才有意义，一次都没跑过就别显示 0%。 */
function successRate(prompt: JailbreakPrompt): string {
  const total = prompt.stats.success + prompt.stats.partial + prompt.stats.failed;
  if (total === 0) return '—';
  return `${Math.round((prompt.stats.success / total) * 100)}%`;
}

export function JailbreakPromptPage() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PromptFormValues>();
  const [editing, setEditing] = useState<JailbreakPrompt | null>(null);
  const [open, setOpen] = useState(false);

  const prompts = useQuery({ queryKey: ['jailbreakPrompts'], queryFn: api.jailbreakPrompts });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['jailbreakPrompts'] });

  const save = useMutation({
    mutationFn: (values: PromptFormValues) => {
      if (editing) {
        // 不传 name：名字是抽取记录里的 promptVersion，改名会让历史战绩对不上。
        return api.updateJailbreakPrompt(editing.id, {
          content: values.content,
          sortOrder: values.sortOrder,
          enabled: values.enabled,
        });
      }
      return api.createJailbreakPrompt({
        name: values.name.trim(),
        content: values.content,
        sortOrder: values.sortOrder,
        enabled: values.enabled,
      });
    },
    onSuccess: () => {
      message.success(editing ? '已保存' : '提示词已新增');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      api.updateJailbreakPrompt(input.id, { enabled: input.enabled }),
    onSuccess: (prompt) => {
      message.success(prompt.enabled ? '已启用' : '已停用');
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteJailbreakPrompt(id),
    onSuccess: () => {
      message.success('已删除');
      refresh();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const openCreate = () => {
    setEditing(null);
    const nextOrder = Math.max(0, ...(prompts.data ?? []).map((p) => p.sortOrder)) + 10;
    form.setFieldsValue({ name: '', content: '', sortOrder: nextOrder, enabled: true });
    setOpen(true);
  };

  const openEdit = (prompt: JailbreakPrompt) => {
    setEditing(prompt);
    form.setFieldsValue({
      name: prompt.name,
      content: prompt.content,
      sortOrder: prompt.sortOrder,
      enabled: prompt.enabled,
    });
    setOpen(true);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message="改措辞前先看一眼战绩"
        description="内置的三版是反复试出来的，改一个字都可能让成功率掉下去。成功率突然下滑时先怀疑站点或模型策略变了，而不是提示词写得不好——建议新加一版对比，而不是直接改动老版本。"
      />
      <Alert
        type="info"
        showIcon
        message="抽取时按顺序号从小到大逐个试，任一版套出提示词就收工"
        description="把命中率高的排前面能省掉大量无效请求。停用的版本不参与抽取，但历史战绩保留。改动对正在运行的任务无效，下次启动生效。"
      />

      <Card
        title="越狱提示词"
        extra={
          <Button type="primary" onClick={openCreate}>
            新增一版
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={prompts.isLoading}
          dataSource={prompts.data ?? []}
          pagination={false}
          columns={[
            { title: '顺序', dataIndex: 'sortOrder', width: 70 },
            { title: '名称', dataIndex: 'name', width: 120 },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 80,
              render: (enabled: boolean, row: JailbreakPrompt) => (
                <Switch
                  size="small"
                  checked={enabled}
                  loading={toggle.isPending && toggle.variables?.id === row.id}
                  onChange={(next) => toggle.mutate({ id: row.id, enabled: next })}
                />
              ),
            },
            {
              title: '成功率',
              width: 90,
              render: (_, row: JailbreakPrompt) => successRate(row),
            },
            {
              title: '成功 / 部分 / 失败',
              width: 150,
              render: (_, row: JailbreakPrompt) =>
                `${row.stats.success} / ${row.stats.partial} / ${row.stats.failed}`,
            },
            {
              title: '正文',
              dataIndex: 'content',
              ellipsis: true,
              render: (content: string) => (
                <Typography.Text type="secondary">{content.slice(0, 60)}…</Typography.Text>
              ),
            },
            {
              title: '最后修改',
              width: 190,
              render: (_, row: JailbreakPrompt) => (
                <Space size={4} direction="vertical">
                  <Typography.Text type="secondary">
                    {new Date(row.updatedAt).toLocaleString('zh-CN')}
                  </Typography.Text>
                  {row.updatedBy ? <Tag>{row.updatedBy}</Tag> : null}
                </Space>
              ),
            },
            {
              title: '操作',
              width: 130,
              render: (_, row: JailbreakPrompt) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => openEdit(row)}>
                    查看 / 编辑
                  </Button>
                  <Popconfirm
                    title="删除这一版？"
                    description="已抽取的记录不受影响，但这一版的战绩会从列表里消失。"
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

      <Drawer
        open={open}
        width={720}
        title={editing ? `编辑 ${editing.name}` : '新增越狱提示词'}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        extra={
          <Space>
            <Button
              onClick={() => {
                setOpen(false);
                setEditing(null);
              }}
            >
              取消
            </Button>
            <Button type="primary" loading={save.isPending} onClick={() => void form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item
            name="name"
            label="名称"
            extra={
              editing
                ? '名称是抽取记录里的版本号，改名会让历史战绩对不上，所以不允许修改'
                : '会原样写进每条抽取记录，建议用 v4、v5 这样的短名字'
            }
            rules={[{ required: true, message: '填写名称' }, { max: JAILBREAK_NAME_MAX }]}
          >
            <Input disabled={Boolean(editing)} placeholder="v4" />
          </Form.Item>
          <Space size={24}>
            <Form.Item name="sortOrder" label="顺序号" extra="小的先试">
              <InputNumber min={0} max={9999} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item
            name="content"
            label="提示词正文"
            rules={[{ required: true, message: '填写正文' }, { max: JAILBREAK_CONTENT_MAX }]}
          >
            <Input.TextArea rows={20} className="prompt-editor" />
          </Form.Item>
        </Form>
      </Drawer>
    </Space>
  );
}
