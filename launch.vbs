Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' 获取脚本所在目录
strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' 检查端口 3000 是否已被占用
Set objExec = objShell.Exec("cmd /c netstat -ano | findstr :3000 | findstr LISTENING")
strOutput = ""
Do While Not objExec.StdOut.AtEndOfStream
    strOutput = strOutput & objExec.StdOut.ReadLine()
Loop

If strOutput <> "" Then
    ' 端口已占用，直接打开浏览器
    objShell.Run "http://localhost:3000", 1, False
    WScript.Quit
End If

' 静默启动 node 服务
objShell.CurrentDirectory = strDir
objShell.Run "cmd /c node src/index.js", 0, False

' 等待服务启动
WScript.Sleep 2500

' 打开浏览器
objShell.Run "http://localhost:3000", 1, False
