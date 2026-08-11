const os = require('node:os');

const fallbackUsername = process.env.USERNAME || process.env.USER || 'local-user';
const fallbackHomedir = process.env.USERPROFILE || process.env.HOME || process.cwd();

try {
  os.userInfo();
} catch (error) {
  if (error?.syscall !== 'uv_os_get_passwd') throw error;
  os.userInfo = () => ({
    uid: -1,
    gid: -1,
    username: fallbackUsername,
    homedir: fallbackHomedir,
    shell: null,
  });
}
