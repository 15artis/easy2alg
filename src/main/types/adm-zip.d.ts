// 最小本地类型声明：仅覆盖 elibz2 连接器用到的 adm-zip API。
// 官方 @types/adm-zip 因沙箱网络限制未能安装，后续如安装可删除本文件。
declare module "adm-zip" {
  interface AdmZipEntry {
    entryName: string;
    name: string;
    isDirectory: boolean;
  }
  class AdmZip {
    constructor(filePath?: string);
    getEntries(): AdmZipEntry[];
    readFile(entry: AdmZipEntry): Buffer | null;
    readAsText(entry: AdmZipEntry): string;
  }
  export = AdmZip;
}
