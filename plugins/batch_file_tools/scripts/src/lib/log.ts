export function writeLogLine(msg: string): void{
  process.stderr.write(msg+'\n');
};