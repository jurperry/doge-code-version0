export const PROCESS_IMAGE_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CuProcessImage {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static string Get(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return "";
        try {
            StringBuilder path = new StringBuilder(32768);
            uint length = (uint)path.Capacity;
            return QueryFullProcessImageName(process, 0, path, ref length) ? path.ToString() : "";
        } finally {
            CloseHandle(process);
        }
    }
}
'@
`
