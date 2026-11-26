import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Two to four options side by side, one row per point of comparison. */
export function ComparisonElement({ rows, options }: { rows: string[]; options: { title: string; values: string[] }[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <span className="sr-only">Compared</span>
          </TableHead>
          {options.map((option, index) => (
            <TableHead key={index} scope="col" className="align-bottom whitespace-normal text-strong">
              {option.title}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, at) => (
          <TableRow key={at}>
            <TableHead scope="row" className="align-top font-normal whitespace-normal text-muted-foreground">
              {row}
            </TableHead>
            {options.map((option, index) => (
              <TableCell key={index} className="min-w-24 align-top break-words whitespace-pre-wrap">
                {option.values[at]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
