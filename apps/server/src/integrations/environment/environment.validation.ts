import {
  IsIn,
  IsNotEmpty,
  IsNotIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MinLength,
  ValidateIf,
  validateSync
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IsISO6391 } from '../../common/validators/is-iso6391';

export class EnvironmentVariables {
  @IsNotEmpty()
  @IsUrl(
    {
      protocols: ['postgres', 'postgresql'],
      require_tld: false,
      allow_underscores: true
    },
    { message: 'DATABASE_URL must be a valid postgres connection string' }
  )
  DATABASE_URL: string;

  @IsNotEmpty()
  @IsUrl(
    {
      protocols: ['redis', 'rediss'],
      require_tld: false,
      allow_underscores: true
    },
    { message: 'REDIS_URL must be a valid redis connection string' }
  )
  REDIS_URL: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  APP_URL: string;

  @IsNotEmpty()
  @MinLength(32)
  @IsNotIn(['REPLACE_WITH_LONG_SECRET'])
  APP_SECRET: string;

  @IsOptional()
  @IsIn(['local', 's3', 'azure'])
  STORAGE_DRIVER: string;

  @IsOptional()
  @ValidateIf((obj) => obj.COLLAB_URL != '' && obj.COLLAB_URL != null)
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  COLLAB_URL: string;

  @IsOptional()
  CLOUD: boolean;

  @IsOptional()
  @IsUrl(
    { protocols: [], require_tld: true },
    {
      message:
        'SUBDOMAIN_HOST must be a valid FQDN domain without the http protocol. e.g example.com'
    }
  )
  @ValidateIf((obj) => obj.CLOUD === 'true'.toLowerCase())
  SUBDOMAIN_HOST: string;

  @IsOptional()
  @IsIn(['database', 'typesense'])
  @IsString()
  SEARCH_DRIVER: string;

  @IsOptional()
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_tld: false,
      allow_underscores: true
    },
    {
      message: 'TYPESENSE_URL must be a valid typesense url e.g http://localhost:8108'
    }
  )
  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  TYPESENSE_URL: string;

  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  @IsNotEmpty()
  @IsString()
  TYPESENSE_API_KEY: string;

  @IsOptional()
  @ValidateIf((obj) => obj.SEARCH_DRIVER === 'typesense')
  @IsISO6391()
  @IsString()
  TYPESENSE_LOCALE: string;

  @ValidateIf((obj) => obj.AI_API_URL || obj.AI_API_KEY || obj.AI_MODEL)
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  @IsNotEmpty()
  AI_API_URL: string;

  @ValidateIf((obj) => obj.AI_API_URL || obj.AI_API_KEY || obj.AI_MODEL)
  @IsString()
  @IsNotEmpty()
  AI_API_KEY: string;

  @ValidateIf((obj) => obj.AI_API_URL || obj.AI_API_KEY || obj.AI_MODEL)
  @IsString()
  @IsNotEmpty()
  AI_MODEL: string;

  @IsOptional()
  @ValidateIf((obj) => obj.AI_REASONING_EFFORT !== undefined && obj.AI_REASONING_EFFORT !== '')
  @IsIn(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  @IsString()
  AI_REASONING_EFFORT: string;

  @IsOptional()
  @ValidateIf((obj) => obj.AI_TEXT_VERBOSITY !== undefined && obj.AI_TEXT_VERBOSITY !== '')
  @IsIn(['low', 'medium', 'high'])
  @IsString()
  AI_TEXT_VERBOSITY: string;

  @IsOptional()
  @IsIn(['postgres', 'clickhouse'])
  @IsString()
  EVENT_STORE_DRIVER: string;

  @ValidateIf((obj) => obj.EVENT_STORE_DRIVER === 'clickhouse')
  @IsNotEmpty()
  @IsUrl(
    { protocols: ['http', 'https'], require_tld: false },
    {
      message: 'CLICKHOUSE_URL must be a valid URL e.g http://user:password@localhost:8123/docmost'
    }
  )
  CLICKHOUSE_URL: string;
}

export function validate(config: Record<string, any>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config);

  const errors = validateSync(validatedConfig);

  if (errors.length > 0) {
    console.error('The Environment variables has failed the following validations:');

    errors.map((error) => {
      console.error(JSON.stringify(error.constraints));
    });

    console.error('Please fix the environment variables and try again. Exiting program...');
    process.exit(1);
  }

  return validatedConfig;
}
