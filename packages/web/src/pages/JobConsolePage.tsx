import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  InputNumber,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_JOB_PARAMS,
  isJobActive,
  type Job,
  type JobKind,
  type JobParams,
} from '@aiero/shared';
import { api } from '../lib/api';

/** 任务在跑时刷得勤一点，让进度看起来是活的；闲着时降下来省请求。 */
const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 20_000;

const KIND_LABEL: Record<JobKind, string> = {
  full: '同步列表 + 抽取提示词',
  list: '只同步角色卡列表',
  extract: '只抽取已入库的角色卡',
};

const STATUS_COLOR: Record<Job['status'], string> = {
  queued: 'default',
  running: 'processing',
  stopping: 'warning',
  stopped: 'default',
  completed: 'success',
  failed: 'error',
};

const STATUS_LABEL: Record<Job['status'], string> = {
  queued: '排队中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
};

export function JobConsolePage() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<JobParams & { kind: JobKind }>();

  const activeJob = useQuery({
    queryKey: ['activeJob'],
    queryFn: api.activeJob,
    refetchInterval: (query) =>
      query.state.data && isJobActive(query.state.data.status) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  });

  const running = activeJob.data && isJobActive(activeJob.data.status) ? activeJob.data : null;

  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: running ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  });

  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: IDLE_POLL_MS });

  // 可选的越狱提示词来自提示词库，新增一版立刻能在这里选到。
  const jailbreakPrompts = useQuery({
    queryKey: ['jailbreakPrompts'],
    queryFn: api.jailbreakPrompts,
  });
  const enabledPrompts = useMemo(
    () => (jailbreakPrompts.data ?? []).filter((prompt) => prompt.enabled),
    [jailbreakPrompts.data]
  );

  const logs = useQuery({
    queryKey: ['jobLogs', running?.id],
    queryFn: () => api.jobLogs(running!.id),
    enabled: Boolean(running),
    refetchInterval: ACTIVE_POLL_MS,
  });

  const [starting, setStarting] = useState(false);

  const startJob = useMutation({
    mutationFn: async (values: JobParams & { kind: JobKind }) => {
      const { kind, ...params } = values;
      return api.startJob(kind, params);
    },
    onSuccess: () => {
      message.success('任务已启动');
      void queryClient.invalidateQueries({ queryKey: ['activeJob'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error: Error) => message.error(error.message),
    onSettled: () => setStarting(false),
  });

  const stopJob = useMutation({
    mutationFn: (jobId: string) => api.stopJob(jobId),
    onSuccess: () => {
      message.info('已请求停止，任务会在当前这张卡处理完后收尾');
      void queryClient.invalidateQueries({ queryKey: ['activeJob'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const stats = overview.data;
  const processed = stats ? stats.success + stats.partial + stats.failed : 0;
  const percent =
    stats && stats.appsTotal > 0 ? Math.round((processed / stats.appsTotal) * 100) : 0;

  const logLines = useMemo(() => (logs.data ?? []).slice().reverse(), [logs.data]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={5}>
          <Card>
            <Statistic title="已发现角色卡" value={stats?.appsTotal ?? 0} />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic title="待抽取" value={stats?.pending ?? 0} />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic
              title="抽取成功"
              value={stats?.success ?? 0}
              valueStyle={{ color: '#0f766e' }}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card>
            <Statistic title="部分成功" value={stats?.partial ?? 0} />
          </Card>
        </Col>
        <Col span={4}>
          <Card>
            <Statistic title="失败" value={stats?.failed ?? 0} valueStyle={{ color: '#b45309' }} />
          </Card>
        </Col>
      </Row>

      <Card title="抓取进度">
        <Progress percent={percent} status={running ? 'active' : 'normal'} />
        <Typography.Text type="secondary">
          已处理 {processed} / {stats?.appsTotal ?? 0} 张角色卡
        </Typography.Text>
      </Card>

      {running ? (
        <Card
          title="当前任务"
          extra={
            <Popconfirm
              title="停止当前任务？"
              description="正在抽取的角色卡会放回队列，不会记成失败。"
              onConfirm={() => stopJob.mutate(running.id)}
              okText="停止"
              cancelText="取消"
            >
              <Button danger loading={stopJob.isPending} disabled={running.status === 'stopping'}>
                停止任务
              </Button>
            </Popconfirm>
          }
        >
          <Descriptions column={3} size="small">
            <Descriptions.Item label="类型">{KIND_LABEL[running.kind]}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_COLOR[running.status]}>{STATUS_LABEL[running.status]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="发起人">{running.createdBy ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="本次成功">{running.stats.success}</Descriptions.Item>
            <Descriptions.Item label="本次部分">{running.stats.partial}</Descriptions.Item>
            <Descriptions.Item label="本次失败">{running.stats.failed}</Descriptions.Item>
            <Descriptions.Item label="已翻页数">{running.stats.pagesDone}</Descriptions.Item>
            <Descriptions.Item label="新发现角色卡">
              {running.stats.appsDiscovered}
            </Descriptions.Item>
            <Descriptions.Item label="并发数">{running.params.workers}</Descriptions.Item>
            <Descriptions.Item label="越狱提示词" span={2}>
              {running.params.jailbreakVersions.length > 0
                ? running.params.jailbreakVersions.join(' / ')
                : '全部启用的'}
            </Descriptions.Item>
          </Descriptions>

          <Typography.Title level={5} style={{ marginTop: 16 }}>
            运行日志
          </Typography.Title>
          <div className="log-stream">
            {logLines.length === 0 ? (
              <div>等待日志…</div>
            ) : (
              logLines.map((entry) => (
                <div key={entry.id} className={`log-${entry.level}`}>
                  {new Date(entry.createdAt).toLocaleTimeString('zh-CN')} {entry.message}
                </div>
              ))
            )}
          </div>
        </Card>
      ) : (
        <Card title="启动新任务">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="同一时刻只允许一个任务运行"
            description="抽取靠的是站点账号，并发开太大会触发限流甚至封号。默认三个并发是实测下来比较稳的值。"
          />
          <Form
            form={form}
            layout="inline"
            initialValues={{ kind: 'full', ...DEFAULT_JOB_PARAMS }}
            onFinish={(values) => {
              setStarting(true);
              startJob.mutate(values);
            }}
          >
            <Form.Item name="kind" label="任务类型">
              <Select style={{ width: 220 }} options={objectToOptions(KIND_LABEL)} />
            </Form.Item>
            <Form.Item name="workers" label="并发数">
              <InputNumber min={1} max={16} />
            </Form.Item>
            <Form.Item name="maxRounds" label="最多续写轮数">
              <InputNumber min={1} max={30} />
            </Form.Item>
            <Form.Item name="taskDelay" label="抽取间隔（秒）">
              <InputNumber min={0} max={60} step={0.5} />
            </Form.Item>
            <Form.Item name="listDelay" label="翻页间隔（秒）">
              <InputNumber min={0.2} max={60} step={0.5} />
            </Form.Item>
            <Form.Item name="maxPages" label="最多翻页">
              <InputNumber min={1} max={100000} />
            </Form.Item>
            <Form.Item
              name="jailbreakVersions"
              label="越狱提示词"
              style={{ minWidth: 300 }}
              extra="留空表示用全部启用的"
            >
              <Select
                mode="multiple"
                allowClear
                placeholder={enabledPrompts.length > 0 ? '全部启用的' : '提示词库里没有启用的版本'}
                loading={jailbreakPrompts.isLoading}
                options={enabledPrompts.map((prompt) => ({
                  label: prompt.name,
                  value: prompt.name,
                }))}
                style={{ minWidth: 200 }}
              />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={starting}>
                启动任务
              </Button>
            </Form.Item>
          </Form>
        </Card>
      )}

      <Card title="历史任务">
        <Table
          rowKey="id"
          size="small"
          dataSource={jobs.data ?? []}
          loading={jobs.isLoading}
          pagination={false}
          columns={[
            {
              title: '类型',
              dataIndex: 'kind',
              render: (kind: JobKind) => KIND_LABEL[kind],
            },
            {
              title: '状态',
              dataIndex: 'status',
              render: (status: Job['status']) => (
                <Tag color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Tag>
              ),
            },
            {
              title: '成功 / 部分 / 失败',
              render: (_, row: Job) =>
                `${row.stats.success} / ${row.stats.partial} / ${row.stats.failed}`,
            },
            { title: '发起人', dataIndex: 'createdBy', render: (v: string | null) => v ?? '—' },
            {
              title: '开始时间',
              dataIndex: 'startedAt',
              render: (value: string | null) =>
                value ? new Date(value).toLocaleString('zh-CN') : '—',
            },
            {
              title: '错误',
              dataIndex: 'error',
              ellipsis: true,
              render: (value: string | null) => value ?? '—',
            },
          ]}
        />
      </Card>
    </Space>
  );
}

function objectToOptions(source: Record<string, string>) {
  return Object.entries(source).map(([value, label]) => ({ value, label }));
}
