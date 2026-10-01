import { StudioApp } from "@/components/StudioApp";
import { createSampleProject } from "@/lib/video/sample-project";

export default function Home() {
  return <StudioApp initialProject={createSampleProject()} />;
}
