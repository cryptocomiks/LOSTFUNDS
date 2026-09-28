import { Checker } from "@/components/Checker";
import { Footer } from "@/components/Footer";
import { Guides } from "@/components/Guides";
import { Header } from "@/components/Header";
import { HowItWorks } from "@/components/HowItWorks";
import { Safety } from "@/components/Safety";
import { ShowReel } from "@/components/ShowReel";
import { Stats } from "@/components/Stats";
import { Tip } from "@/components/Tip";

export default function Home() {
  return (
    <>
      <Header />
      <main>
        <Checker />
        <Stats />
        <ShowReel />
        <HowItWorks />
        <Guides />
        <Tip />
        <Safety />
      </main>
      <Footer />
    </>
  );
}
