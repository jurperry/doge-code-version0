import { describe, expect, test } from 'bun:test'
import {publicV6UrlCandidates,  nicPriority, webUrlCandidates } from './adapters/webChat.js'
import type { NetworkInterfaceInfoIPv4 } from 'os'

// 0.2.93：多网卡机器上 VMware/WSL/蓝牙 等虚拟地址会抢二维码主位置，
// 169.254 链路本地则是打不开的死链——过滤与排序规则钉死在此。
describe('nicPriority 扫码地址过滤排序', () => {
  test('物理网卡按家用网段优先', () => {
    expect(nicPriority('以太网', '192.168.1.169')).toBe(0)
    expect(nicPriority('WLAN', '10.0.0.5')).toBe(1)
    expect(nicPriority('以太网 2', '172.20.1.9')).toBe(2)
  })

  test('虚拟网卡一律排除（中英文 Windows 网卡名）', () => {
    expect(nicPriority('VMware Network Adapter VMnet8', '192.168.219.1')).toBeNull()
    expect(nicPriority('vEthernet (WSL)', '172.23.144.1')).toBeNull()
    expect(nicPriority('蓝牙网络连接', '169.254.138.244')).toBeNull()
    expect(nicPriority('Bluetooth Network Connection 2', '192.168.43.7')).toBeNull()
    expect(nicPriority('本地连接* 3', '169.254.106.135')).toBeNull()
    expect(nicPriority('Local Area Connection* 12', '192.168.137.1')).toBeNull()
    expect(nicPriority('Wi-Fi Direct virtual adapter', '192.168.44.9')).toBeNull()
    expect(nicPriority('vgate0', '172.30.250.122')).toBeNull()
    expect(nicPriority('Loopback Pseudo-Interface 1', '127.0.0.1')).toBeNull()
  })

  test('链路本地与回环地址排除（即便物理网卡名）', () => {
    expect(nicPriority('以太网 3', '169.254.94.33')).toBeNull()
    expect(nicPriority('以太网', '127.0.0.1')).toBeNull()
  })

  test('CGNAT 垫底、公网地址兜底', () => {
    expect(nicPriority('WLAN', '100.77.66.207')).toBe(3)
    expect(nicPriority('以太网', '8.8.8.8')).toBe(4)
  })
})

function nic(addr: string): NetworkInterfaceInfoIPv4 {
  return {
    address: addr,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${addr}/24`,
  } as NetworkInterfaceInfoIPv4
}

describe('webUrlCandidates 出货函数（注入网卡表）', () => {
  test('虚拟地址剔除、物理网卡按优先级排主位', () => {
    const urls = webUrlCandidates(4764, 'tok123', {
      'VMware Network Adapter VMnet8': [nic('192.168.219.1')],
      vgate0: [nic('172.30.250.122')],
      '以太网 3': [nic('169.254.94.33')],
      以太网: [nic('192.168.1.169')],
      WLAN: [nic('10.1.2.3')],
    })
    expect(urls).toEqual([
      'http://192.168.1.169:4764/#t=tok123',
      'http://10.1.2.3:4764/#t=tok123',
    ])
  })

  test('IPv6 与 internal 接口跳过', () => {
    const urls = webUrlCandidates(4764, 't', {
      loopback: [{ ...nic('127.0.0.1'), internal: true }],
      以太网: [nic('192.168.0.5')],
    })
    expect(urls).toEqual(['http://192.168.0.5:4764/#t=t'])
  })
})

describe('publicV6UrlCandidates（公网 IPv6 直连候选，2.1.273）', () => {
  const nics = (map: Record<string, Array<{ address: string; family?: string; internal?: boolean }>>) =>
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, v.map((x) => ({ address: x.address, family: x.family ?? 'IPv6', internal: x.internal ?? false, mac: '', cidr: '', scopeid: 0 }))]),
    )

  test('全局单播入选（2/3 开头）；链路本地/ULA/回环/internal/虚拟网卡排除', () => {
    const injected = nics({
      以太网: [{ address: '2408:845a:12::1' }, { address: '240e:888::ab' }, { address: 'fe80::1' }, { address: 'fd00::1' }, { address: '::1', internal: true }],
      vEthernet: [{ address: '2409:1111::1' }],
      本地环回: [{ address: '240a::9', internal: true }],
    })
    const out = publicV6UrlCandidates(4764, 'tok', injected as never)
    expect(out).toEqual(['http://[2408:845a:12::1]:4764/#t=tok', 'http://[240e:888::ab]:4764/#t=tok'])
  })

  test('无全局 v6 时空数组（v4-only 机器）', () => {
    expect(publicV6UrlCandidates(4764, 'tok', nics({ 以太网: [{ address: 'fe80::5' }, { address: 'fd12::1' }] }) as never)).toEqual([])
  })
})
