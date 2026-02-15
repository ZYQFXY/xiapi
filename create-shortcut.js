// 在桌面创建快捷方式，指向当前项目的 launch.vbs
// 用法: node create-shortcut.js [快捷方式名称]
// 示例: node create-shortcut.js 2号客户接口2

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const name = process.argv[2] || '虾皮控制台';
const projectDir = path.resolve(__dirname);
const vbsPath = path.join(projectDir, 'launch.vbs');

const ps1 = [
  '$ws = New-Object -ComObject WScript.Shell',
  '$desktop = $ws.SpecialFolders("Desktop")',
  `$sc = $ws.CreateShortcut("$desktop\\${name}.lnk")`,
  `$sc.TargetPath = "${vbsPath}"`,
  `$sc.WorkingDirectory = "${projectDir}"`,
  '$sc.Save()',
].join('\r\n');

const tmpFile = path.join(projectDir, '_tmp_shortcut.ps1');
fs.writeFileSync(tmpFile, '\ufeff' + ps1, 'utf8');

try {
  execSync(`powershell -ExecutionPolicy Bypass -File "${tmpFile}"`, { stdio: 'inherit' });
  console.log(`桌面快捷方式 "${name}" 已创建`);
} finally {
  fs.unlinkSync(tmpFile);
}
