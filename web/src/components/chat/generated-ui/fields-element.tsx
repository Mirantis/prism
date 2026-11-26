/** Labeled values, in two columns where the card is wide enough. */
export function FieldsElement({ fields }: { fields: { label: string; value: string }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 @[32rem]:grid-cols-2">
      {fields.map((field, index) => (
        <div key={index} className="min-w-0">
          <dt className="text-[0.8125rem] break-words text-muted-foreground">{field.label}</dt>
          <dd className="break-words whitespace-pre-wrap text-foreground">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
