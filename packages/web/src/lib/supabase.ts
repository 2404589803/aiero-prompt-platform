import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY');
}

/**
 * 只用来登录拿 JWT，业务数据一律走后端。
 * storageKey 单独取名，避免和同域下运营平台的会话互相覆盖。
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'aiero-prompt-platform-auth',
  },
});
