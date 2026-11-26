/* ── Grey placeholder shapes while a Studio place reads (US-57) ──
   The sketches grid, the design systems list, a sketch while it opens and its prototype show the shape of what is
   coming instead of "Reading..." text. Each one says what it waits for to a screen reader, and stays still when the
   computer asks for less motion. */

function Box({ w = '100%', h }: { w?: string; h: number | string }) {
  return <span className="skel-box" style={{ width: w, height: h }} />;
}

/** The sketches grid: a few cards, each a thumbnail and two lines. */
export function SketchesSkeleton() {
  return (
    <ul className="skel skel-cards" role="status" aria-label="Loading the sketches">
      {[0, 1, 2].map((i) => (
        <li key={i} className="skel-card">
          <Box h={150} />
          <Box w="60%" h={14} />
          <Box w="40%" h={11} />
        </li>
      ))}
    </ul>
  );
}

/** The design systems list: a lead line and a few cards, each a row of colours and two lines. */
export function DesignSystemsSkeleton() {
  return (
    <div className="skel" role="status" aria-label="Loading the design systems">
      <Box w="320px" h={12} />
      <ul className="skel-cards" style={{ marginTop: 16 }}>
        {[0, 1].map((i) => (
          <li key={i} className="skel-card">
            <span style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3].map((j) => (
                <Box key={j} w="22px" h={22} />
              ))}
            </span>
            <Box w="55%" h={14} />
            <Box w="35%" h={11} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A sketch while it opens: the screen's page, a header band and a few blocks inside it. */
export function SketchSkeleton({ what = 'the sketch' }: { what?: string }) {
  return (
    <div className="skel skel-ws" role="status" aria-label={`Loading ${what}`}>
      <Box h={40} />
      <Box w="45%" h={22} />
      <Box h={180} />
      <Box w="70%" h={14} />
      <Box w="30%" h={40} />
    </div>
  );
}

/** The prototype: a row of screen cards. */
export function PrototypeSkeleton() {
  return (
    <div className="skel skel-pt" role="status" aria-label="Loading the prototype">
      {[0, 1, 2].map((i) => (
        <span key={i} className="skel-card" style={{ width: 220 }}>
          <Box h={140} />
          <Box w="50%" h={12} />
        </span>
      ))}
    </div>
  );
}
