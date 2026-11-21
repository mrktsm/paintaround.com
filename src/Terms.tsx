import LegalPage, { Section } from './legal/LegalPage';

export default function Terms() {
  return (
    <LegalPage title="Terms of Use" updated="November 2026">
      <p>By using I Was Here, you agree to these terms.</p>

      <Section heading="Be decent">
        <p style={{ margin: 0 }}>Don't draw anything hateful, sexual, threatening or illegal, don't post other people's personal information, and don't spam. Don't try to break or overload the service.</p>
      </Section>

      <Section heading="Your drawings">
        <p style={{ margin: 0 }}>Your drawings are yours. By drawing, you let us show them live to other people viewing the same place. Drawings are temporary and disappear once everyone has left that place.</p>
      </Section>

      <Section heading="Moderation">
        <p style={{ margin: 0 }}>We may remove drawings or block devices that break these terms, at our discretion.</p>
      </Section>

      <Section heading="Photos and maps">
        <p style={{ margin: 0 }}>Photos and map data belong to their owners and are credited in the app. Some photos are licensed CC BY-SA; drawings made on those count as adaptations and are shared under the same license.</p>
      </Section>

      <Section heading="No guarantees">
        <p style={{ margin: 0 }}>The service is provided "as is", without warranties. To the extent the law allows, we aren't liable for losses arising from its use.</p>
      </Section>

      <Section heading="Changes and contact">
        <p style={{ margin: 0 }}>We may update these terms; the date above shows the latest version. Questions: <a href="mailto:markotsymbaluk@gmail.com" style={{ color: '#007aff' }}>markotsymbaluk@gmail.com</a>.</p>
      </Section>
    </LegalPage>
  );
}
