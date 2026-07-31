import GameClient from "@/components/GameClient";

export default async function PlayPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <GameClient code={code.toUpperCase()} />;
}
