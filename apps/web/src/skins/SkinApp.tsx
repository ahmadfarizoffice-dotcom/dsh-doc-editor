/** Skin dispatcher: selects one of the four chrome shells. */
import { GdocsSkin } from "./GdocsSkin";
import { PagesSkin } from "./PagesSkin";
import { WordSkin } from "./WordSkin";
import { WriterSkin } from "./WriterSkin";
import type { SkinProps } from "./skinContext";

export function SkinApp(props: SkinProps): React.JSX.Element {
  switch (props.skin) {
    case "word":
      return <WordSkin {...props} />;
    case "pages":
      return <PagesSkin {...props} />;
    case "writer":
      return <WriterSkin {...props} />;
    case "gdocs":
    default:
      return <GdocsSkin {...props} />;
  }
}
