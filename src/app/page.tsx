import { BackToTop } from "@/components/BackToTop";
import { Categories } from "@/components/Categories";
import { Checker } from "@/components/Checker";
import { Compare } from "@/components/Compare";
import { Faq } from "@/components/Faq";
import { Footer } from "@/components/Footer";
import { Guides } from "@/components/Guides";
import { Header } from "@/components/Header";
import { HowItWorks } from "@/components/HowItWorks";
import { Safety } from "@/components/Safety";
import { ShowReel } from "@/components/ShowReel";
import { Stats } from "@/components/Stats";
import { Tip } from "@/components/Tip";
import { Unclaimed } from "@/components/Unclaimed";

export default function Home() {
  return (
    <>
      <Header />
      <main>
        <Checker />
        <Stats />
        <Unclaimed />
        <Categories />
        <HowItWorks />
        <ShowReel />
        <Compare />
        <Guides />
        <Faq />
        <Tip />
        <Safety />
      </main>
      <Footer />
      <BackToTop />
    </>
  );
}
