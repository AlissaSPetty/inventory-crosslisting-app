update public.integration_credentials set shop_domain = '' where shop_domain is null;
alter table public.integration_credentials
  alter column shop_domain set default '',
  alter column shop_domain set not null;
